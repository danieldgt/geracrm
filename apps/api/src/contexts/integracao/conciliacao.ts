import { randomUUID } from 'node:crypto'
import type { Sql } from '../../db/index.js'
import { jsonbDe } from '../../db/jsonb.js'

/**
 * Reconciliation — what turns "I imported" into "I checked it is right".
 *
 * ⚠️ This is the Wave 0 exit criterion nº 1, and it is the step everyone skips.
 * A row count proves nothing: a wrongly imported row counts too.
 *
 * The reconciliation compares, per period, what came in against what the ERP
 * says. The divergence is the product here; zero is just the happy case.
 */

export interface TotaisDoErp {
  readonly periodoDe: Date
  readonly periodoAte: Date
  /**
   * ⚠️ OPCIONAL: nem todo relatório do ERP dá contagem. O de faturamento do
   * GeraCloud, por exemplo, só informa o VALOR. Quando ausente, a conciliação é
   * por valor — que é o número que mais importa (R$ 40 mil faltando é erro de
   * carga; três vendas a menos pode ser cancelamento). Confundir "não informou"
   * com "zero" faria toda venda importada aparecer como excedente.
   */
  readonly registros?: number
  readonly valorCentavos?: number
  /** Sample of external ids, so a divergence can actually be investigated. */
  readonly idsExternos?: readonly string[]
}

export interface ResultadoConciliacao {
  readonly periodoDe: string
  readonly totalErp: number
  readonly totalGeracrm: number
  readonly divergenciaRegistros: number
  readonly divergenciaValorCentavos: number
  /** Se os dois lados fecham. ⚠️ Bater não é o mesmo que estar conferido: quem
   *  confere é uma pessoa, e é isso que `estado` reflete. */
  readonly bate: boolean
  /** O estado REALMENTE gravado. Nunca 'conferida' aqui — esse estado só existe
   *  depois que alguém aceita, e devolver 'conferida' faria a tela mostrar
   *  conferido sem ninguém ter conferido. */
  readonly estado: 'pendente' | 'divergente'
  readonly faltantes: string[]
}

const LIMITE_AMOSTRA = 100

/**
 * @param totaisErp what the ERP reports for each period — obtained from a report
 *   the customer already trusts, NOT from the same endpoint used to import.
 *   ⚠️ Reconciling an import against the source of that same import proves only
 *   that we can copy; it does not prove the numbers are right.
 */
export async function conciliarVendas(
  tx: Sql,
  tenantId: string,
  conexaoId: string,
  totaisErp: readonly TotaisDoErp[],
): Promise<ResultadoConciliacao[]> {
  const sistema = `erp:${conexaoId}`
  const resultados: ResultadoConciliacao[] = []

  for (const periodo of totaisErp) {
    const [nosso] = await tx<{ registros: string; valor: string | null }[]>`
      SELECT count(*)::text AS registros,
             coalesce(sum(valor_centavos), 0)::text AS valor
        FROM venda
       WHERE tenant_id = ${tenantId}
         AND ocorrida_em >= ${periodo.periodoDe}
         AND ocorrida_em <  ${periodo.periodoAte}
         AND cancelada_em IS NULL
    `

    // ⚠️ bigint volta como string do driver. Somar sem converter concatena.
    const totalGeracrm = Number(nosso?.registros ?? 0)
    const valorGeracrm = Number(nosso?.valor ?? 0)

    // Which ids the ERP reported and we do not have. This is what makes a
    // divergence investigable — "faltam 12" is not actionable, "these 12" is.
    let faltantes: string[] = []
    if (periodo.idsExternos?.length) {
      const presentes = await tx<{ id_externo: string }[]>`
        SELECT id_externo FROM venda_identidade_externa
         WHERE tenant_id = ${tenantId} AND sistema = ${sistema}
           AND id_externo = ANY(${[...periodo.idsExternos]}::text[])
      `
      const conhecidos = new Set(presentes.map((p) => p.id_externo))
      faltantes = periodo.idsExternos.filter((id) => !conhecidos.has(id)).slice(0, LIMITE_AMOSTRA)
    }

    // ⚠️ Só compara contagem se o ERP informou contagem. Sem isso, `registros`
    //    ausente viraria "0 - nossoTotal", uma divergência gigante e falsa.
    const conferindoRegistros = periodo.registros !== undefined
    const divergenciaRegistros = conferindoRegistros ? periodo.registros! - totalGeracrm : 0
    const conferindoValor = periodo.valorCentavos !== undefined
    const divergenciaValor = conferindoValor ? periodo.valorCentavos! - valorGeracrm : 0

    // ⚠️ Divergence in VALUE outranks divergence in count. Three fewer sales may
    // be cancellations; forty thousand reais missing is an import failure.
    // ⚠️ Só o que foi realmente comparado conta para "bater": um relatório que
    //    dá só valor não pode ser declarado conferido na contagem que não viu.
    const bate = divergenciaRegistros === 0 && divergenciaValor === 0
    // ⚠️ Bater vira 'pendente', não 'conferida': esse estado exige responsável
    // nomeado (restrição da migration 0018). O sistema apura; a pessoa aceita.
    // Apuração que se auto-aprova não é conferência.
    const estado = bate ? 'pendente' : 'divergente'

    const [linha] = await tx<{ id: string }[]>`
      INSERT INTO conciliacao (tenant_id, id, conexao_id, fluxo, periodo_de, periodo_ate,
                               total_erp, total_geracrm, valor_erp_centavos, valor_geracrm_centavos,
                               faltantes, estado, apurado_em)
      VALUES (${tenantId}, ${randomUUID()}, ${conexaoId}, 'orders',
              ${periodo.periodoDe}, ${periodo.periodoAte},
              ${periodo.registros ?? null}, ${totalGeracrm},
              ${periodo.valorCentavos ?? null}, ${valorGeracrm},
              ${jsonbDe(faltantes)}::text::jsonb, ${estado}, now())
      ON CONFLICT (tenant_id, conexao_id, fluxo, periodo_de) DO UPDATE
        SET total_erp = EXCLUDED.total_erp,
            total_geracrm = EXCLUDED.total_geracrm,
            valor_erp_centavos = EXCLUDED.valor_erp_centavos,
            valor_geracrm_centavos = EXCLUDED.valor_geracrm_centavos,
            faltantes = EXCLUDED.faltantes,
            estado = EXCLUDED.estado,
            apurado_em = now(),
            -- Reapurar limpa o aceite anterior: o número mudou, a conferência
            -- de antes não vale mais.
            aceito_por = NULL, aceito_em = NULL
      RETURNING id
    `

    await registrarDivergencias(tx, tenantId, linha!.id, faltantes, {
      valorErpCentavos: periodo.valorCentavos ?? 0,
      valorGeracrmCentavos: valorGeracrm,
    })

    resultados.push({
      periodoDe: periodo.periodoDe.toISOString().slice(0, 10),
      totalErp: periodo.registros ?? 0,
      totalGeracrm,
      divergenciaRegistros,
      divergenciaValorCentavos: divergenciaValor,
      bate,
      estado,
      faltantes,
    })
  }

  return resultados
}

/**
 * Abre uma linha por divergência, com os dois lados.
 *
 * ⚠️ É o que separa "importei" de "sei o que não bateu e quem está cuidando".
 * A amostra em JSON na `conciliacao` continua existindo para o relatório, mas
 * ela não tem dono nem estado — e o critério de saída nº 1 pede um RC
 * consultável, não um retrato.
 *
 * ⚠️ `ON CONFLICT DO NOTHING`: reapurar o mesmo período NÃO reabre divergência
 * que alguém já resolveu. Sem isso, a apuração noturna desfaz todo dia o
 * trabalho da véspera, e a lista nunca chega a zero.
 */
async function registrarDivergencias(
  tx: Sql,
  tenantId: string,
  conciliacaoId: string,
  faltantes: readonly string[],
  totais: { valorErpCentavos: number; valorGeracrmCentavos: number },
): Promise<void> {
  for (const idExterno of faltantes) {
    await tx`
      INSERT INTO conciliacao_divergencia (tenant_id, id, conciliacao_id, codigo, chave, valor_erp)
      VALUES (${tenantId}, ${randomUUID()}, ${conciliacaoId}, 'DIV-01', ${idExterno}, 'presente')
      -- ⚠️ Registro faltando específico: DO NOTHING para não reabrir o que
      --    alguém já resolveu. A resolução de um id é definitiva.
      ON CONFLICT (tenant_id, conciliacao_id, codigo, chave) DO NOTHING
    `
  }

  // ⚠️ Divergência de valor SEM registro faltando é caso diferente e pior: as
  // vendas são as mesmas e os totais não batem, então algo foi importado com o
  // valor errado. Contar linhas nunca acharia isso.
  const divergenciaValor = totais.valorErpCentavos - totais.valorGeracrmCentavos
  if (divergenciaValor !== 0 && faltantes.length === 0) {
    await tx`
      INSERT INTO conciliacao_divergencia (tenant_id, id, conciliacao_id, codigo, chave,
                                           valor_erp, valor_geracrm)
      VALUES (${tenantId}, ${randomUUID()}, ${conciliacaoId}, 'DIV-03', 'total_do_periodo',
              -- ⚠️ Os DOIS lados reais, não a diferença. Guardar a diferença em
              --    valor_erp mente sobre quanto o ERP tem — e a tela mostraria
              --    "ERP: R$ 12 mil" quando o ERP tem R$ 60 mil.
              ${String(totais.valorErpCentavos)}, ${String(totais.valorGeracrmCentavos)})
      ON CONFLICT (tenant_id, conciliacao_id, codigo, chave) DO UPDATE
        -- ⚠️ O total é recomputado a cada apuração — ao contrário do id
        --    faltante, ele DEVE refletir os números de agora. Mas só enquanto
        --    ninguém aceitou: uma divergência de total já explicada e aceita
        --    não é sobrescrita por uma reapuração.
        SET valor_erp = EXCLUDED.valor_erp, valor_geracrm = EXCLUDED.valor_geracrm
        WHERE conciliacao_divergencia.estado = 'aberta'
    `
  }
}

/**
 * A person accepts the reconciliation. ⚠️ This is what closes exit criterion
 * nº 1 — and it requires a named human, by database constraint. "Conferida"
 * without a responsible party is a rubber stamp, and nobody answers for the
 * base when the divergence surfaces months later.
 */
export async function aceitarConciliacao(
  tx: Sql,
  tenantId: string,
  conciliacaoId: string,
  usuarioId: string,
  observacao?: string,
): Promise<void> {
  await tx`
    UPDATE conciliacao
       SET estado = 'conferida', aceito_por = ${usuarioId}, aceito_em = now(),
           observacao = ${observacao ?? null}
     WHERE tenant_id = ${tenantId} AND id = ${conciliacaoId}
  `
}
