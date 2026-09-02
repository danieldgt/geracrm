import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { sql, type Sql } from '../../db/index.js'

/**
 * Sessão de acesso do staff a um cliente (PLT-05).
 *
 * ⚠️ O token é OPACO e a tradução para tenant é do banco
 * (`tenant_da_sessao_staff`, migration 0082) — o mesmo padrão de
 * `tenant_do_canal` para o webhook. O porquê da escolha, contra um JWT, está na
 * migration; o que importa aqui: expiração e encerramento são checados dentro da
 * função SQL, não neste arquivo, para não existir uma segunda verdade.
 *
 * ⚠️ Só o HASH é guardado. O token em claro existe uma vez, na resposta da
 * emissão — como o segredo do webhook. Perdeu, abre outra sessão.
 */

export const PREFIXO_SESSAO_STAFF = 'staff_'

/** Curta de propósito: é uma janela de suporte, não um login. */
export const DURACAO_SESSAO_MIN = 60

export interface SessaoStaffResolvida {
  readonly tenant_id: string
  readonly sessao_id: string
  readonly ator_sub: string
  readonly ator_email: string
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Traduz o token em tenant. Devolve `null` para token desconhecido, expirado ou
 * encerrado — quem chama trata os três como "sem tenant".
 */
export async function resolverSessaoStaff(token: string): Promise<SessaoStaffResolvida | null> {
  const [linha] = await sql<SessaoStaffResolvida[]>`
    SELECT * FROM tenant_da_sessao_staff(${hash(token)})`
  return linha ?? null
}

export interface SessaoStaffCriada {
  readonly id: string
  readonly token: string
  readonly expiraEm: Date
}

/**
 * Abre a sessão. Roda dentro da transação de quem chama — o contrato exige que a
 * auditoria da emissão esteja no MESMO commit do fato (plano-onda-1, E7-01).
 *
 * ⚠️ `tx` aqui está escopada ao tenant do CLIENTE (via `comTenantServico`), que é
 * o dono da linha: é o cliente que precisa poder ver quem entrou na casa dele.
 */
export async function abrirSessaoStaff(tx: Sql, p: {
  atorSub: string
  atorEmail: string
  motivo: string
}): Promise<SessaoStaffCriada> {
  const token = `${PREFIXO_SESSAO_STAFF}${randomBytes(32).toString('base64url')}`
  const id = randomUUID()
  const [linha] = await tx<{ expira_em: Date }[]>`
    INSERT INTO staff_sessao (tenant_id, id, token_hash, ator_sub, ator_email, motivo, expira_em)
    VALUES (tenant_atual(), ${id}, ${hash(token)}, ${p.atorSub}, ${p.atorEmail}, ${p.motivo},
            now() + ${`${DURACAO_SESSAO_MIN} minutes`}::interval)
    RETURNING expira_em`
  return { id, token, expiraEm: linha!.expira_em }
}

/** Encerra a sessão — o acesso morre na hora, sem esperar a expiração. */
export async function encerrarSessaoStaff(tx: Sql, sessaoId: string): Promise<boolean> {
  const [linha] = await tx<{ id: string }[]>`
    UPDATE staff_sessao SET encerrada_em = now()
     WHERE tenant_id = tenant_atual() AND id = ${sessaoId} AND encerrada_em IS NULL
    RETURNING id`
  return Boolean(linha)
}
