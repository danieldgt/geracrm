import { randomUUID } from 'node:crypto'
import type { Sql } from '../../db/index.js'
import { resolverOrigensPendentes } from './resolucao-origem.js'
import type { EstruturaVeiculacao, PortaPlataformaMidia } from './plataformas/porta.js'

/**
 * SINCRONIZADOR DE MÍDIA (AQ-05) — traz estrutura e custo da plataforma para o
 * nosso banco.
 *
 * ⚠️ Roda como DONO (worker), com `tenant_id` explícito — igual ao
 * `automacao-motor` e ao despachante de conversões.
 *
 * ⚠️ **Tudo é UPSERT, e isso não é zelo.** As plataformas REESCREVEM métricas de
 * dias já fechados enquanto a janela de atribuição assenta (até ~28 dias), e a
 * estrutura muda de estado o tempo todo. Ressincronizar é o caso NORMAL, não a
 * exceção — um `INSERT` puro duplicaria custo a cada passada.
 */

/** Janela relida a cada passada. ⚠️ Ver acima: 30 dias cobre o assentamento. */
export const DIAS_JANELA_SINCRONIZACAO = 30

export interface ResumoSincronizacao {
  readonly campanhas: number
  readonly conjuntos: number
  readonly anuncios: number
  readonly diasDeMetrica: number
  /** ⚠️ Linhas de métrica descartadas por citarem anúncio que não conhecemos. */
  readonly metricasOrfas: number
  readonly origensResolvidas: number
  /** ⚠️ Requisições gastas — é o número que diz quantas contas cabem na cota. */
  readonly chamadas: number
  readonly erro?: { motivo: string; detalhe?: string | undefined }
}

const VAZIO: ResumoSincronizacao = {
  campanhas: 0, conjuntos: 0, anuncios: 0, diasDeMetrica: 0,
  metricasOrfas: 0, origensResolvidas: 0, chamadas: 0,
}

/**
 * Grava a hierarquia. ⚠️ **Pai antes de filho, sempre** — conjunto referencia
 * campanha e anúncio referencia conjunto. Inverter a ordem viola a FK e derruba a
 * passada inteira por um detalhe de sequência.
 */
async function gravarEstrutura(
  sql: Sql, tenantId: string, contaId: string, e: EstruturaVeiculacao,
): Promise<{ campanhas: number; conjuntos: number; anuncios: number }> {
  const idPorExterno = new Map<string, string>()

  for (const c of e.campanhas) {
    const [linha] = await sql<{ id: string }[]>`
      INSERT INTO midia_campanha (tenant_id, id, conta_id, id_externo, nome, estado)
      VALUES (${tenantId}, ${randomUUID()}, ${contaId}, ${c.idExterno}, ${c.nome}, ${c.estado})
      ON CONFLICT (tenant_id, conta_id, id_externo)
      DO UPDATE SET nome = EXCLUDED.nome, estado = EXCLUDED.estado
      RETURNING id`
    idPorExterno.set(`c:${c.idExterno}`, linha!.id)
  }

  for (const g of e.conjuntos) {
    const campanhaId = idPorExterno.get(`c:${g.paiExternoId ?? ''}`)
    // ⚠️ Conjunto órfão é pulado, não inventado: sem a campanha, a hierarquia
    //    mentiria e o total por campanha não fecharia.
    if (!campanhaId) continue
    const [linha] = await sql<{ id: string }[]>`
      INSERT INTO midia_conjunto (tenant_id, id, campanha_id, id_externo, nome, estado)
      VALUES (${tenantId}, ${randomUUID()}, ${campanhaId}, ${g.idExterno}, ${g.nome}, ${g.estado})
      ON CONFLICT (tenant_id, campanha_id, id_externo)
      DO UPDATE SET nome = EXCLUDED.nome, estado = EXCLUDED.estado
      RETURNING id`
    idPorExterno.set(`g:${g.idExterno}`, linha!.id)
  }

  let anuncios = 0
  for (const a of e.anuncios) {
    const conjuntoId = idPorExterno.get(`g:${a.paiExternoId ?? ''}`)
    if (!conjuntoId) continue
    await sql`
      INSERT INTO midia_anuncio (tenant_id, id, conjunto_id, id_externo, nome, estado)
      VALUES (${tenantId}, ${randomUUID()}, ${conjuntoId}, ${a.idExterno}, ${a.nome}, ${a.estado})
      ON CONFLICT (tenant_id, conjunto_id, id_externo)
      DO UPDATE SET nome = EXCLUDED.nome, estado = EXCLUDED.estado`
    anuncios++
  }

  return {
    campanhas: e.campanhas.length,
    conjuntos: [...idPorExterno.keys()].filter((k) => k.startsWith('g:')).length,
    anuncios,
  }
}

/**
 * Uma passada de sincronização numa conta.
 *
 * ⚠️ Estrutura ANTES de métrica: `midia_metrica_dia` tem FK para `midia_anuncio`,
 * e métrica de anúncio desconhecido não tem onde pousar.
 */
export async function sincronizarConta(
  sql: Sql,
  p: {
    tenantId: string
    contaId: string
    contaExternaId: string
    adaptador: PortaPlataformaMidia
    agora: Date
    diasJanela?: number
  },
): Promise<ResumoSincronizacao> {
  const chamadasDe = (): number =>
    (p.adaptador as unknown as { chamadas?: number }).chamadas ?? 0
  const chamadasAntes = chamadasDe()
  const comChamadas = (r: Omit<ResumoSincronizacao, 'chamadas'>): ResumoSincronizacao =>
    ({ ...r, chamadas: chamadasDe() - chamadasAntes })

  if (!p.adaptador.capacidades.leituraEstrutura) {
    // ⚠️ Degrada com motivo nomeado — é o que a fábrica devolve sem credencial.
    return comChamadas({ ...VAZIO, erro: { motivo: 'plataforma_sem_capacidade' } })
  }

  const estrutura = await p.adaptador.lerEstrutura(p.contaExternaId)
  if (!estrutura.ok) {
    return comChamadas({ ...VAZIO, erro: { motivo: estrutura.motivo, detalhe: estrutura.detalhe } })
  }
  const contagens = await gravarEstrutura(sql, p.tenantId, p.contaId, estrutura.dados)

  const dias = p.diasJanela ?? DIAS_JANELA_SINCRONIZACAO
  const ate = p.agora.toISOString().slice(0, 10)
  const de = new Date(p.agora.getTime() - dias * 86_400_000).toISOString().slice(0, 10)

  const metricas = await p.adaptador.lerMetricas(p.contaExternaId, { de, ate })
  if (!metricas.ok) {
    return comChamadas({
      ...VAZIO, ...contagens, erro: { motivo: metricas.motivo, detalhe: metricas.detalhe },
    })
  }

  let gravadas = 0
  let orfas = 0
  for (const m of metricas.dados) {
    // ⚠️ Resolve o anúncio pelo id EXTERNO dentro do tenant. Métrica de anúncio
    //    que não veio na estrutura é contada como ÓRFÃ, não engolida: se o número
    //    subir, a leitura de estrutura está incompleta e o custo não fecha.
    const [a] = await sql<{ id: string }[]>`
      SELECT a.id FROM midia_anuncio a
        JOIN midia_conjunto cj ON cj.tenant_id = a.tenant_id AND cj.id = a.conjunto_id
        JOIN midia_campanha c  ON c.tenant_id = cj.tenant_id AND c.id = cj.campanha_id
       WHERE a.tenant_id = ${p.tenantId} AND c.conta_id = ${p.contaId}
         AND a.id_externo = ${m.anuncioExternoId}
       LIMIT 1`
    if (!a) { orfas++; continue }

    await sql`
      INSERT INTO midia_metrica_dia
        (tenant_id, anuncio_id, dia, impressoes, cliques, custo_centavos, conversoes_plataforma)
      VALUES (${p.tenantId}, ${a.id}, ${m.dia}, ${m.impressoes}, ${m.cliques},
              ${m.custoCentavos}, ${m.conversoesPlataforma})
      ON CONFLICT (tenant_id, anuncio_id, dia)
      DO UPDATE SET impressoes = EXCLUDED.impressoes, cliques = EXCLUDED.cliques,
                    custo_centavos = EXCLUDED.custo_centavos,
                    conversoes_plataforma = EXCLUDED.conversoes_plataforma,
                    atualizado_em = now()`
    gravadas++
  }

  // ⚠️ Aqui, e não antes: a estrutura acabou de chegar, então este é o momento em
  //    que os leads pendentes finalmente têm com o que casar.
  const resolucao = await resolverOrigensPendentes(sql, p.tenantId)

  return comChamadas({
    ...contagens,
    diasDeMetrica: gravadas,
    metricasOrfas: orfas,
    origensResolvidas: resolucao.resolvidas,
  })
}
