import { comTenantServico, type Sql } from '../db/index.js'
import {
  anonimizarContato, candidatosDeAnonimizacao, registrarFalhaAnonimizacao,
} from '../contexts/crm/lgpd-anonimizacao.js'

/**
 * WORKER DE RETENÇÃO LGPD (raia H2) — agendado em `server.ts` (1×/dia, com batimento).
 *
 * ⚠️ Só para tenant com `tenant.lgpd_auto = true` (DESLIGADO por padrão; o admin liga depois da
 *    prévia e da confirmação — `POST /v1/lgpd/automatica`). Tenant desligado nem é lido.
 *
 * Por tenant (como DONO só para listar os tenants ligados; todo o resto sob `comTenantServico`, RLS):
 *   1. lê até `LOTE` candidatos (descartados além da retenção e opt-outs com mais de 15 dias —
 *      regras em `lgpd-anonimizacao.ts`);
 *      (a chave `lgpd_auto` é relida a cada lote: desligada no meio, a passada para);
 *   2. anonimiza CADA contato na sua própria transação (uma falha não desfaz os outros);
 *      — e, DENTRO da transação, depois do `FOR UPDATE`, reavalia o predicado do motivo: se o contato
 *      não casa mais, pula sem erro (`nao_elegivel`);
 *   3. contato que falha ganha `lgpd_falha` (só o CÓDIGO), sai desta passada e vai para o fim da fila
 *      nas próximas — nunca trava os demais;
 *   4. repete até `MAX_LOTES_POR_TENANT` lotes ou até estourar o orçamento de tempo (checado também
 *      DENTRO do lote) — o que sobrar é pego na próxima passada.
 *
 * ⚠️ Log só com contagens e códigos — nunca nome, telefone, texto de contato ou erro cru.
 * Idempotente: duas passadas simultâneas disputam a linha (`FOR UPDATE`) e a segunda vê `jaAnonimizado`.
 */
export const INTERVALO_LGPD_MS = 24 * 3_600_000
/** Primeira passada logo depois do boot (deploy mais frequente que 1×/dia nunca chegaria às 24 h). */
export const ATRASO_PRIMEIRA_PASSADA_LGPD_MS = 5 * 60_000
const LOTE = 200
const MAX_LOTES_POR_TENANT = 5
const ORCAMENTO_PADRAO_MS = 60_000

export interface RelatorioLgpdWorker {
  readonly tenants: number
  readonly processadas: number
  readonly anonimizados: number
  readonly falhas: number
  /** Códigos das falhas e quantas vezes (sem dado pessoal). */
  readonly codigosFalha: Readonly<Record<string, number>>
  /** Parou por orçamento de tempo antes de zerar os candidatos — retoma no próximo ciclo. */
  readonly interrompido: boolean
}

export interface DepsLgpd {
  readonly somenteTenant?: string | undefined
  readonly orcamentoMs?: number | undefined
  readonly lote?: number | undefined
  /** Relógio injetável para o orçamento (testes). */
  readonly relogio?: (() => number) | undefined
  /** Só para teste: roda depois de cada contato processado. */
  readonly depoisDoContato?: (() => void) | undefined
  /** Só para teste: substitui a anonimização (para simular falha de um contato). */
  readonly anonimizar?: typeof anonimizarContato | undefined
}

/** Código curto e seguro de um erro (nunca a mensagem, que pode carregar dado). */
export function codigoDoErro(e: unknown): string {
  const codigo = (e as { code?: unknown } | null)?.code
  if (typeof codigo === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(codigo)) return `pg_${codigo}`
  if (e instanceof Error && /^[A-Za-z0-9_.-]{1,40}$/.test(e.name)) return e.name
  return 'erro_desconhecido'
}

export async function processarLgpd(dono: Sql, deps: DepsLgpd = {}, agora: Date = new Date()): Promise<RelatorioLgpdWorker> {
  const relogio = deps.relogio ?? Date.now
  const limite = relogio() + (deps.orcamentoMs ?? ORCAMENTO_PADRAO_MS)
  const lote = deps.lote ?? LOTE
  const anonimizar = deps.anonimizar ?? anonimizarContato
  const tenants = await dono<{ id: string }[]>`
    SELECT id FROM tenant
     WHERE lgpd_auto AND ativo AND ${deps.somenteTenant ? dono`id = ${deps.somenteTenant}` : dono`true`}
     ORDER BY id`

  let processadas = 0, anonimizados = 0, falhas = 0, interrompido = false
  const codigosFalha: Record<string, number> = {}
  for (const t of tenants) {
    const falharamNestaPassada: string[] = []
    for (let n = 0; n < MAX_LOTES_POR_TENANT; n++) {
      if (relogio() >= limite) { interrompido = true; break }
      // O admin pode desligar a automática no meio da passada: relê a chave a CADA lote.
      const [ligada] = await comTenantServico(t.id, (tx) => tx<{ lgpd_auto: boolean }[]>`
        SELECT lgpd_auto FROM tenant WHERE id = tenant_atual()`)
      if (!ligada?.lgpd_auto) break
      const candidatos = await comTenantServico(t.id, (tx) =>
        candidatosDeAnonimizacao(tx, { agora, limite: lote, excluir: falharamNestaPassada }))
      if (candidatos.length === 0) break
      let progresso = 0
      for (const c of candidatos) {
        if (relogio() >= limite) { interrompido = true; break }
        processadas++
        let codigo: string | null = null
        try {
          const r = await comTenantServico(t.id, (tx) => anonimizar(tx, c.id, { motivo: c.motivo, agora, reavaliarSeletor: true }))
          if (r.ok && !r.jaAnonimizado) { anonimizados++; progresso++ }
          // `nao_elegivel`: o fato mudou depois da leitura do lote (cliente voltou) — pula, sem erro.
          else if (!r.ok && r.erro !== 'nao_elegivel') codigo = r.erro
        } catch (e) {
          codigo = codigoDoErro(e)
        }
        if (codigo) {
          falhas++
          codigosFalha[codigo] = (codigosFalha[codigo] ?? 0) + 1
          falharamNestaPassada.push(c.id)
          await comTenantServico(t.id, (tx) => registrarFalhaAnonimizacao(tx, c.id, codigo, agora)).catch(() => undefined)
        }
        deps.depoisDoContato?.()
      }
      // Sem progresso (só recusas/falhas): não insiste neste tenant agora.
      if (interrompido || progresso === 0) break
    }
    if (interrompido) break
  }
  return { tenants: tenants.length, processadas, anonimizados, falhas, codigosFalha, interrompido }
}
