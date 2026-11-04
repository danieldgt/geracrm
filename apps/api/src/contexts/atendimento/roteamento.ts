import {
  dddDoTelefone, proximoDoRodizio, resolverFilial, type FilialResolvida, type PessoaRoteavel, type RegraAplicavel,
  type TipoRegraRoteamento,
} from '@geracrm/shared'
import type { Sql } from '../../db/index.js'
import { naoEhLinhaDeStaff } from '../identidade/linha-staff.js'

/**
 * ROTEAMENTO POR FILIAL E RODÍZIO — o lado com banco (raia G4, #71/#91).
 *
 * A decisão é pura (shared `resolverFilial`, `proximoDoRodizio`, `rotearHandoff`);
 * aqui só se lê o que ela precisa e se grava o ponteiro do rodízio. Tudo sob
 * `tenant_atual()` (ADR-001) — chamado pela ingestão, pelo handoff do agente e
 * pela simulação, nunca com tenant de parâmetro.
 *
 * ⚠️ RODÍZIO SEM CORRIDA: o ponteiro (`rodizio_filial`) é TRAVADO por linha
 *    (`INSERT … ON CONFLICT DO UPDATE … RETURNING`) antes de ser lido. Dois
 *    contatos novos ao mesmo tempo: o segundo espera o commit do primeiro e lê o
 *    ponteiro já avançado — nunca pegam o mesmo vendedor fora da vez. A simulação
 *    lê SEM travar e não grava (`avancar: false`).
 */

export type FinalidadeRodizio = 'entrada' | 'handoff'

/**
 * Quem entra no rodízio de cada finalidade (papel NA FILIAL, `usuario_filial`).
 * ⚠️ 'entrada' dá CARTEIRA: só `vendedor` — o atendente é "atendimento, sem
 *    carteira" (0005). 'handoff' é atender o cliente agora: vendedor e atendente.
 * ⚠️ Vínculo com `filial_id NULL` ("todas") NÃO entra no rodízio de uma filial
 *    específica — a mesma régua do escopo (`escopo.ts`: quem é de todas não
 *    pertence a filial nenhuma). Ele segue no pool do número.
 */
const PAPEIS_DO_RODIZIO: Record<FinalidadeRodizio, readonly string[]> = {
  entrada: ['vendedor'],
  handoff: ['vendedor', 'atendente'],
}
const PAPEIS_GESTAO_FILIAL = ['gestor', 'supervisor', 'admin'] as const
const TETO_ELEGIVEIS = 100

/** As regras que PODEM casar com estes fatos (ativas, do número ou gerais). Teto de 50. */
async function regrasCandidatas(
  tx: Sql, f: { origemId: string | null; ddd: string | null; canalId: string | null },
): Promise<RegraAplicavel[]> {
  const linhas = await tx<{
    id: string; canal_id: string | null; tipo: TipoRegraRoteamento; valor: string | null; filial_id: string
    prioridade: number; ativa: boolean; filial_ativa: boolean
  }[]>`
    SELECT r.id, r.canal_id, r.tipo, r.valor, r.filial_id, r.prioridade, r.ativa, f.ativa AS filial_ativa
      FROM regra_roteamento r
      JOIN filial f ON f.tenant_id = r.tenant_id AND f.id = r.filial_id
     WHERE r.tenant_id = tenant_atual() AND r.ativa
       AND ${f.canalId ? tx`(r.canal_id IS NULL OR r.canal_id = ${f.canalId}::uuid)` : tx`r.canal_id IS NULL`}
       AND (r.tipo = 'padrao'
            OR ${f.origemId ? tx`(r.tipo = 'origem' AND r.valor = ${f.origemId.toLowerCase()})` : tx`false`}
            OR ${f.ddd ? tx`(r.tipo = 'ddd' AND r.valor = ${f.ddd})` : tx`false`})
     ORDER BY r.prioridade, r.id
     LIMIT 50`
  return linhas.map((l) => ({
    id: l.id, canalId: l.canal_id, tipo: l.tipo, valor: l.valor, filialId: l.filial_id,
    prioridade: l.prioridade, ativa: l.ativa, filialAtiva: l.filial_ativa,
  }))
}

/** A filial do NÚMERO (`canal_conectado.filial_id`), se ativa. */
async function filialAtivaDoNumero(tx: Sql, canalId: string | null): Promise<string | null> {
  if (!canalId) return null
  const [l] = await tx<{ filial_id: string }[]>`
    SELECT cc.filial_id FROM canal_conectado cc
      JOIN filial f ON f.tenant_id = cc.tenant_id AND f.id = cc.filial_id AND f.ativa
     WHERE cc.tenant_id = tenant_atual() AND cc.id = ${canalId}`
  return l?.filial_id ?? null
}

export interface FilialDoContato extends FilialResolvida {
  readonly ddd: string | null
}

/**
 * A filial por FATOS soltos (a simulação não tem contato): origem, telefone e número.
 * `filialDoContato` = a filial já gravada (só vale se ativa — quem chama confere).
 */
export async function filialPorFatos(
  tx: Sql, f: { filialDoContato?: string | null; origemId: string | null; telefone: string | null; canalId: string | null },
): Promise<FilialDoContato> {
  const ddd = dddDoTelefone(f.telefone)
  if (f.filialDoContato) return { filialId: f.filialDoContato, motivo: 'contato', regraId: null, ddd }
  const regras = await regrasCandidatas(tx, { origemId: f.origemId, ddd, canalId: f.canalId })
  const filialDoNumero = await filialAtivaDoNumero(tx, f.canalId)
  return { ...resolverFilial(regras, { filialDoContato: null, origemId: f.origemId, ddd, canalId: f.canalId, filialDoNumero }), ddd }
}

/**
 * `filialDoContato(tx, contato, canal)` — filial já gravada no contato → regra
 * por origem → regra por DDD do telefone principal → regra padrão do número →
 * filial do número → regra padrão geral → nenhuma. Contato inexistente → nenhuma.
 */
export async function filialDoContato(tx: Sql, contatoId: string, canalId: string | null): Promise<FilialDoContato> {
  const [c] = await tx<{ filial_ativa: string | null; origem_id: string | null; e164: string | null }[]>`
    SELECT (SELECT f.id FROM filial f WHERE f.tenant_id = c.tenant_id AND f.id = c.filial_id AND f.ativa) AS filial_ativa,
           c.origem_id,
           (SELECT t.e164 FROM contato_telefone t
             WHERE t.tenant_id = c.tenant_id AND t.contato_id = c.id
             ORDER BY t.principal DESC, t.seq LIMIT 1) AS e164
      FROM contato c
     WHERE c.tenant_id = tenant_atual() AND c.id = ${contatoId}`
  if (!c) return { filialId: null, motivo: 'nenhuma', regraId: null, ddd: null }
  return filialPorFatos(tx, { filialDoContato: c.filial_ativa, origemId: c.origem_id, telefone: c.e164, canalId })
}

/**
 * Os ELEGÍVEIS do rodízio de uma filial: ATIVOS, NÃO ausentes, com papel da
 * finalidade NA filial e que atendem o número (`usuario_canal` com ele, ou
 * número SEM ninguém vinculado — o mesmo "todos atendem" da notificação e do
 * escopo). Sem número (`canalId` null), só a filial e o papel. Ordem por id.
 */
export async function elegiveisDaFilial(
  tx: Sql, filialId: string, canalId: string | null, finalidade: FinalidadeRodizio,
): Promise<PessoaRoteavel[]> {
  const papeis = [...PAPEIS_DO_RODIZIO[finalidade]]
  const atendeONumero = canalId
    ? tx`(EXISTS (SELECT 1 FROM usuario_canal uc WHERE uc.tenant_id = u.tenant_id AND uc.canal_id = ${canalId}::uuid AND uc.usuario_id = u.id)
              OR NOT EXISTS (SELECT 1 FROM usuario_canal uc WHERE uc.tenant_id = u.tenant_id AND uc.canal_id = ${canalId}::uuid))`
    : tx`true`
  return tx<PessoaRoteavel[]>`
    SELECT u.id, u.ativo, u.ausente
      FROM usuario u
     WHERE u.tenant_id = tenant_atual() AND u.ativo AND NOT u.ausente
       AND ${naoEhLinhaDeStaff(tx, 'u')}
       AND EXISTS (SELECT 1 FROM usuario_filial uf
                    JOIN filial f ON f.tenant_id = uf.tenant_id AND f.id = uf.filial_id AND f.ativa
                   WHERE uf.tenant_id = u.tenant_id AND uf.usuario_id = u.id
                     AND uf.filial_id = ${filialId}::uuid AND uf.papel = ANY(${papeis}::text[]))
       AND ${atendeONumero}
     ORDER BY u.id
     LIMIT ${TETO_ELEGIVEIS}`
}

/** Admin/gestor/supervisor ATIVOS com papel NA filial, gestor primeiro. Teto de 20. */
export async function gestoresDaFilial(tx: Sql, filialId: string): Promise<PessoaRoteavel[]> {
  return tx<PessoaRoteavel[]>`
    SELECT u.id, u.ativo, u.ausente
      FROM usuario u
     WHERE u.tenant_id = tenant_atual() AND u.ativo AND ${naoEhLinhaDeStaff(tx, 'u')}
       AND EXISTS (SELECT 1 FROM usuario_filial uf
                    WHERE uf.tenant_id = u.tenant_id AND uf.usuario_id = u.id AND uf.filial_id = ${filialId}::uuid
                      AND uf.papel IN ${tx(PAPEIS_GESTAO_FILIAL)})
     ORDER BY (SELECT min(array_position(${PAPEIS_GESTAO_FILIAL as unknown as string[]}::text[], uf.papel))
                 FROM usuario_filial uf
                WHERE uf.tenant_id = u.tenant_id AND uf.usuario_id = u.id AND uf.filial_id = ${filialId}::uuid), u.id
     LIMIT 20`
}

/**
 * TRAVA o ponteiro do rodízio da filial e devolve o último escolhido. A trava
 * dura até o fim da transação de quem chama: quem vier depois espera e lê o
 * ponteiro já gravado (`ON CONFLICT DO UPDATE` sempre opera na versão mais nova).
 */
export async function travarRodizio(tx: Sql, filialId: string, finalidade: FinalidadeRodizio): Promise<string | null> {
  const [l] = await tx<{ ultimo_usuario_id: string | null }[]>`
    INSERT INTO rodizio_filial (tenant_id, filial_id, finalidade)
    VALUES (tenant_atual(), ${filialId}, ${finalidade})
    ON CONFLICT (tenant_id, filial_id, finalidade) DO UPDATE SET atualizado_em = rodizio_filial.atualizado_em
    RETURNING ultimo_usuario_id`
  return l?.ultimo_usuario_id ?? null
}

/** Grava o escolhido no ponteiro (a linha já está travada por `travarRodizio`). */
export async function gravarRodizio(tx: Sql, filialId: string, finalidade: FinalidadeRodizio, usuarioId: string): Promise<void> {
  await tx`
    UPDATE rodizio_filial SET ultimo_usuario_id = ${usuarioId}, atualizado_em = now()
     WHERE tenant_id = tenant_atual() AND filial_id = ${filialId} AND finalidade = ${finalidade}`
}

/** O ponteiro SEM travar (simulação). */
async function lerRodizio(tx: Sql, filialId: string, finalidade: FinalidadeRodizio): Promise<string | null> {
  const [l] = await tx<{ ultimo_usuario_id: string | null }[]>`
    SELECT ultimo_usuario_id FROM rodizio_filial
     WHERE tenant_id = tenant_atual() AND filial_id = ${filialId} AND finalidade = ${finalidade}`
  return l?.ultimo_usuario_id ?? null
}

/**
 * `escolherVendedorDaFilial(tx, filialId, canalId)` — o próximo da vez entre os
 * elegíveis (`elegiveisDaFilial`), por id, depois do último escolhido.
 *   - `avancar: true` (padrão): trava o ponteiro, escolhe e grava — na MESMA
 *     transação do efeito (a carteira, o handoff). Se ela reverter, o ponteiro
 *     reverte junto.
 *   - `avancar: false`: só diz quem seria (simulação) — nem trava nem grava.
 * Sem elegível → null (e o ponteiro não é tocado).
 */
export async function escolherVendedorDaFilial(
  tx: Sql, filialId: string, canalId: string | null,
  op: { finalidade?: FinalidadeRodizio; avancar?: boolean } = {},
): Promise<{ usuarioId: string | null; elegiveis: number }> {
  const finalidade = op.finalidade ?? 'entrada'
  const elegiveis = await elegiveisDaFilial(tx, filialId, canalId, finalidade)
  if (elegiveis.length === 0) return { usuarioId: null, elegiveis: 0 }
  const ids = elegiveis.map((e) => e.id)
  if (op.avancar === false) {
    return { usuarioId: proximoDoRodizio(ids, await lerRodizio(tx, filialId, finalidade)), elegiveis: ids.length }
  }
  const escolhido = proximoDoRodizio(ids, await travarRodizio(tx, filialId, finalidade))!
  await gravarRodizio(tx, filialId, finalidade, escolhido)
  return { usuarioId: escolhido, elegiveis: ids.length }
}
