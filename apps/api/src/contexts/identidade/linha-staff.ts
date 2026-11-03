import type { Sql } from '../../db/index.js'

/**
 * LINHAS DE STAFF LEGADAS em `usuario` do cliente (revisão de segurança D3).
 *
 * Até esta correção, a sessão de staff (PLT-05) gravava uma linha em `usuario`
 * do cliente com o `cognito_sub` e o e-mail do LOGIN do staff (via
 * `garantirUsuarioId`). Hoje a sessão de staff não grava mais nada, mas as
 * linhas antigas continuam no banco — e, expostas no cadastro de usuários,
 * deixariam o admin do cliente redefinir a senha ou bloquear a conta de quem
 * acessa TODOS os clientes.
 *
 * Como reconhecer sem coluna nova: toda linha de staff nasceu DENTRO de uma
 * sessão aberta sobre aquele tenant, e `staff_sessao` (RLS do tenant do
 * CLIENTE) guarda o `ator_sub` de cada sessão — nunca é apagada (encerrar só
 * marca `encerrada_em`). A linha cujo `cognito_sub` é o ator de alguma sessão
 * sobre este tenant é do staff.
 *
 * ⚠️ É a PRIMEIRA camada (some das listagens; o cadastro responde 404). A
 *    segunda é o adaptador do provedor, que recusa operar sobre quem está no
 *    grupo `staff` ou tem `custom:tenant_id` de outro tenant.
 */
export function naoEhLinhaDeStaff(tx: Sql, aliasUsuario = 'u') {
  if (!/^[a-z_][a-z0-9_]*$/.test(aliasUsuario)) throw new Error(`linha-staff: alias inválido "${aliasUsuario}"`)
  const a = tx.unsafe(aliasUsuario)
  return tx`NOT EXISTS (SELECT 1 FROM staff_sessao ls_ss
                         WHERE ls_ss.tenant_id = ${a}.tenant_id AND ls_ss.ator_sub = ${a}.cognito_sub)`
}
