import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  corpoRegraRoteamento, corpoRegraRoteamentoParcial, validarValorDaRegra,
  type NumeroRoteamento, type RegraRoteamento, type SimulacaoRoteamento, type TipoRegraRoteamento,
} from '@geracrm/shared'
import type { Sql } from '../../db/index.js'
import { exigirTenant } from '../../plugins/tenant.js'
import { auditar } from '../plataforma/auditoria.js'
import { escopoDaRequisicao, type Escopo } from '../plataforma/escopo.js'
import { exigirPapel } from '../plataforma/papel.js'
import { atorDaRequisicao, garantirUsuarioId } from './rotas-fila.js'
import { escolherVendedorDaFilial, filialPorFatos } from './roteamento.js'

/**
 * ROTEAMENTO POR FILIAL (raia G4, #71/#91) — regras, a chave por número e o simulador.
 *
 *   GET    /v1/roteamento/regras?cursor=      → { itens: RegraRoteamento[], proximoCursor }   (gestão)
 *   POST   /v1/roteamento/regras              → 201 { id }                                     (admin/gestor)
 *   PATCH  /v1/roteamento/regras/:id          → { ok }                                         (admin/gestor)
 *   DELETE /v1/roteamento/regras/:id          → { ok }                                         (admin/gestor)
 *   GET    /v1/roteamento/numeros             → { itens: NumeroRoteamento[] }                  (gestão)
 *   PUT    /v1/roteamento/numeros/:id         → { ok } corpo { rodizioNaEntrada }              (admin/gestor)
 *   GET    /v1/roteamento/filiais             → { itens: {id,nome,cor}[] } ativas do escopo    (gestão)
 *   GET    /v1/roteamento/simular?telefone=&origemId=&canalId= → SimulacaoRoteamento           (gestão)
 *
 * ⚠️ ESCOPO (D3): gestor/supervisor de FILIAL só vê e mexe nas regras das filiais
 *    dele (regra de outra filial = 404, indistinguível de inexistente; criar para
 *    outra filial = 422 no campo). Admin, gestor de todas e o modo fundador veem tudo.
 *    A chave do número: gestor de filial só nos números da filial dele.
 * ⚠️ A simulação NÃO grava nada e NÃO avança o rodízio (`avancar: false`).
 * ⚠️ Tenant SEMPRE de `tenant_atual()` (ADR-001): filial, número e origem do
 *    corpo são conferidos sob RLS — de outro tenant, não existem (422).
 */

const PAGINA = 50
const TETO_OPCOES = 200
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface Falha { readonly status: number; readonly corpo: { erro: string; mensagem?: string; campos?: string[] } }
const falha = (status: number, erro: string, mensagem?: string, campos?: string[]): Falha =>
  ({ status, corpo: { erro, ...(mensagem ? { mensagem } : {}), ...(campos ? { campos } : {}) } })
const ehFalha = (v: unknown): v is Falha => typeof v === 'object' && v !== null && 'status' in v && 'corpo' in v

const NAO_ENCONTRADA = falha(404, 'roteamento.regra_nao_encontrada')
const DUPLICADA = falha(409, 'roteamento.regra_duplicada', 'Já existe uma regra igual (mesmo tipo, valor e número).', ['valor'])

const ehDuplicada = (e: unknown) =>
  (e as { code?: string })?.code === '23505'
  && String((e as { constraint_name?: string }).constraint_name ?? (e as Error).message).includes('regra_roteamento_unica')

async function garantirUsuario(req: FastifyRequest): Promise<void> {
  if (req.tenantId && !req.atorStaff) await req.comTenant((tx) => garantirUsuarioId(tx, req))
}

/** A filial está no escopo de quem chama? */
const filialNoEscopo = (escopo: Escopo, filialId: string) =>
  escopo.tipo === 'tudo' || (escopo.tipo === 'filial' && escopo.filialIds.includes(filialId))

/** Fragmento: regra (alias `r`) visível no escopo. */
function regraNoEscopo(tx: Sql, escopo: Escopo) {
  if (escopo.tipo === 'tudo') return tx`true`
  if (escopo.tipo === 'filial') return tx`r.filial_id = ANY(${[...escopo.filialIds]}::uuid[])`
  return tx`false`
}

/** Confere filial (ativa, do escopo), número e origem do tenant; normaliza o valor. */
async function conferirAlvos(
  tx: Sql, escopo: Escopo,
  r: { tipo: TipoRegraRoteamento; valor: string | null; filialId: string; canalId: string | null },
  op: { filialMudou: boolean },
): Promise<Falha | { valor: string | null }> {
  const v = validarValorDaRegra(r.tipo, r.valor)
  if (!v.ok) return falha(422, 'roteamento.valor_invalido', v.mensagem, ['valor'])
  if (op.filialMudou) {
    const [f] = await tx<{ ativa: boolean }[]>`SELECT ativa FROM filial WHERE tenant_id = tenant_atual() AND id = ${r.filialId}`
    if (!f || !filialNoEscopo(escopo, r.filialId)) return falha(422, 'roteamento.filial_invalida', 'Filial não encontrada.', ['filialId'])
    if (!f.ativa) return falha(422, 'roteamento.filial_inativa', 'Esta filial está desativada.', ['filialId'])
  }
  if (r.canalId) {
    const [c] = await tx`SELECT 1 FROM canal_conectado WHERE tenant_id = tenant_atual() AND id = ${r.canalId}`
    if (!c) return falha(422, 'roteamento.numero_invalido', 'Número não encontrado.', ['canalId'])
  }
  if (r.tipo === 'origem') {
    const [o] = await tx`SELECT 1 FROM origem WHERE tenant_id = tenant_atual() AND id = ${v.valor}`
    if (!o) return falha(422, 'roteamento.origem_invalida', 'Origem não encontrada.', ['valor'])
  }
  return { valor: v.valor }
}

function recusaZod(reply: FastifyReply, issues: readonly { message: string; path: readonly PropertyKey[] }[]) {
  return reply.code(422).send({
    erro: 'roteamento.invalido',
    mensagem: issues[0]?.message ?? 'Confira os campos da regra.',
    campos: [...new Set(issues.map((i) => String(i.path[0] ?? '')))].filter(Boolean),
  })
}

interface LinhaRegra {
  id: string; tipo: TipoRegraRoteamento; valor: string | null; valor_rotulo: string | null
  filial_id: string; filial_nome: string; filial_ativa: boolean; canal_id: string | null; canal_nome: string | null
  prioridade: number; ativa: boolean; atualizado_em: Date
}
const paraRegra = (l: LinhaRegra): RegraRoteamento => ({
  id: l.id, tipo: l.tipo, valor: l.valor, valorRotulo: l.valor_rotulo, filialId: l.filial_id, filialNome: l.filial_nome,
  filialAtiva: l.filial_ativa, canalId: l.canal_id, canalNome: l.canal_nome, prioridade: l.prioridade, ativa: l.ativa,
  atualizadoEm: l.atualizado_em.toISOString(),
})

export async function rotasRoteamento(app: FastifyInstance): Promise<void> {
  const GESTAO = { preHandler: [exigirTenant, garantirUsuario, exigirPapel('gestor', 'supervisor')] }
  const EDICAO = { preHandler: [exigirTenant, garantirUsuario, exigirPapel('gestor')] }

  // ── regras ──────────────────────────────────────────────────────────────
  /** Lista por cursor `(prioridade, id)` — a ordem em que o mesmo nível desempata. */
  app.get<{ Querystring: { cursor?: string } }>('/v1/roteamento/regras', GESTAO, async (req, reply) => {
    let cur: { prioridade: number; id: string } | null = null
    if (req.query.cursor) {
      const [p, id] = Buffer.from(req.query.cursor, 'base64url').toString('utf8').split('§')
      const prioridade = Number(p)
      if (!Number.isInteger(prioridade) || !id || !UUID.test(id)) return reply.code(422).send({ erro: 'cursor.invalido' })
      cur = { prioridade, id }
    }
    const linhas = await req.comTenant(async (tx) => {
      const escopo = await escopoDaRequisicao(tx, req)
      return tx<LinhaRegra[]>`
        SELECT r.id, r.tipo, r.valor, o.nome AS valor_rotulo, r.filial_id, f.nome AS filial_nome, f.ativa AS filial_ativa,
               r.canal_id, cc.nome_amigavel AS canal_nome, r.prioridade, r.ativa, r.atualizado_em
          FROM regra_roteamento r
          JOIN filial f ON f.tenant_id = r.tenant_id AND f.id = r.filial_id
          LEFT JOIN canal_conectado cc ON cc.tenant_id = r.tenant_id AND cc.id = r.canal_id
          LEFT JOIN origem o ON o.tenant_id = r.tenant_id AND o.id = r.origem_id
         WHERE r.tenant_id = tenant_atual() AND ${regraNoEscopo(tx, escopo)}
           AND ${cur === null ? tx`true` : tx`(r.prioridade, r.id) > (${cur.prioridade}, ${cur.id}::uuid)`}
         ORDER BY r.prioridade ASC, r.id ASC
         LIMIT ${PAGINA + 1}`
    })
    const temMais = linhas.length > PAGINA
    const pagina = temMais ? linhas.slice(0, PAGINA) : linhas
    const ultimo = pagina[pagina.length - 1]
    return reply.send({
      itens: pagina.map(paraRegra),
      proximoCursor: temMais && ultimo ? Buffer.from(`${ultimo.prioridade}§${ultimo.id}`).toString('base64url') : null,
    })
  })

  app.post<{ Body: unknown }>('/v1/roteamento/regras', EDICAO, async (req, reply) => {
    const p = corpoRegraRoteamento.safeParse(req.body ?? {})
    if (!p.success) return recusaZod(reply, p.error.issues)
    const b = p.data
    const id = randomUUID()
    try {
      const r = await req.comTenant(async (tx) => {
        const escopo = await escopoDaRequisicao(tx, req)
        const alvo = await conferirAlvos(tx, escopo, b, { filialMudou: true })
        if (ehFalha(alvo)) return alvo
        const atorId = await atorDaRequisicao(tx, req)
        await tx`
          INSERT INTO regra_roteamento (tenant_id, id, canal_id, tipo, valor, filial_id, prioridade, ativa, atualizado_por)
          VALUES (tenant_atual(), ${id}, ${b.canalId}, ${b.tipo}, ${alvo.valor}, ${b.filialId}, ${b.prioridade}, ${b.ativa}, ${atorId})`
        await auditar(tx, {
          atorId, atorStaff: req.atorStaff === true, acao: 'roteamento.regra_criada', entidade: 'regra_roteamento', entidadeId: id,
          dados: { tipo: b.tipo, valor: alvo.valor, filialId: b.filialId, canalId: b.canalId, prioridade: b.prioridade, ativa: b.ativa },
        })
        return null
      })
      if (r) return reply.code(r.status).send(r.corpo)
    } catch (e) {
      if (ehDuplicada(e)) return reply.code(DUPLICADA.status).send(DUPLICADA.corpo)
      throw e
    }
    return reply.code(201).send({ id })
  })

  app.patch<{ Params: { id: string }; Body: unknown }>('/v1/roteamento/regras/:id', EDICAO, async (req, reply) => {
    const id = req.params.id
    if (!UUID.test(id)) return reply.code(404).send(NAO_ENCONTRADA.corpo)
    const p = corpoRegraRoteamentoParcial.safeParse(req.body ?? {})
    if (!p.success) return recusaZod(reply, p.error.issues)
    const b = p.data
    if (Object.keys(b).length === 0) return reply.code(422).send({ erro: 'roteamento.nada_a_mudar', mensagem: 'Nada a mudar.' })
    try {
      const r = await req.comTenant(async (tx) => {
        const escopo = await escopoDaRequisicao(tx, req)
        const [atual] = await tx<{
          tipo: TipoRegraRoteamento; valor: string | null; filial_id: string; canal_id: string | null; prioridade: number; ativa: boolean
        }[]>`
          SELECT r.tipo, r.valor, r.filial_id, r.canal_id, r.prioridade, r.ativa FROM regra_roteamento r
           WHERE r.tenant_id = tenant_atual() AND r.id = ${id} AND ${regraNoEscopo(tx, escopo)}
           FOR UPDATE`
        if (!atual) return NAO_ENCONTRADA
        // Mescla: trocar o tipo sem mandar o valor apaga o valor antigo (DDD não vira origem).
        const tipo = b.tipo ?? atual.tipo
        const novo = {
          tipo,
          valor: b.valor !== undefined ? b.valor : (b.tipo !== undefined && b.tipo !== atual.tipo ? null : atual.valor),
          filialId: b.filialId ?? atual.filial_id,
          canalId: b.canalId !== undefined ? b.canalId : atual.canal_id,
          prioridade: b.prioridade ?? atual.prioridade,
          ativa: b.ativa ?? atual.ativa,
        }
        const alvo = await conferirAlvos(tx, escopo, novo, { filialMudou: novo.filialId !== atual.filial_id })
        if (ehFalha(alvo)) return alvo
        const atorId = await atorDaRequisicao(tx, req)
        await tx`
          UPDATE regra_roteamento
             SET tipo = ${novo.tipo}, valor = ${alvo.valor}, filial_id = ${novo.filialId}, canal_id = ${novo.canalId},
                 prioridade = ${novo.prioridade}, ativa = ${novo.ativa}, atualizado_em = now(), atualizado_por = ${atorId}
           WHERE tenant_id = tenant_atual() AND id = ${id}`
        await auditar(tx, {
          atorId, atorStaff: req.atorStaff === true, acao: 'roteamento.regra_alterada', entidade: 'regra_roteamento', entidadeId: id,
          dados: {
            antes: { tipo: atual.tipo, valor: atual.valor, filialId: atual.filial_id, canalId: atual.canal_id, prioridade: atual.prioridade, ativa: atual.ativa },
            depois: { ...novo, valor: alvo.valor },
          },
        })
        return null
      })
      if (r) return reply.code(r.status).send(r.corpo)
    } catch (e) {
      if (ehDuplicada(e)) return reply.code(DUPLICADA.status).send(DUPLICADA.corpo)
      throw e
    }
    return reply.send({ ok: true })
  })

  app.delete<{ Params: { id: string } }>('/v1/roteamento/regras/:id', EDICAO, async (req, reply) => {
    const id = req.params.id
    if (!UUID.test(id)) return reply.code(404).send(NAO_ENCONTRADA.corpo)
    const ok = await req.comTenant(async (tx) => {
      const escopo = await escopoDaRequisicao(tx, req)
      const [apagada] = await tx<{ tipo: string; valor: string | null; filial_id: string; canal_id: string | null }[]>`
        DELETE FROM regra_roteamento r
         WHERE r.tenant_id = tenant_atual() AND r.id = ${id} AND ${regraNoEscopo(tx, escopo)}
        RETURNING r.tipo, r.valor, r.filial_id, r.canal_id`
      if (!apagada) return false
      await auditar(tx, {
        atorId: await atorDaRequisicao(tx, req), atorStaff: req.atorStaff === true, acao: 'roteamento.regra_removida',
        entidade: 'regra_roteamento', entidadeId: id,
        dados: { tipo: apagada.tipo, valor: apagada.valor, filialId: apagada.filial_id, canalId: apagada.canal_id },
      })
      return true
    })
    if (!ok) return reply.code(404).send(NAO_ENCONTRADA.corpo)
    return reply.send({ ok: true })
  })

  // ── a chave por número ─────────────────────────────────────────────────
  /** Os números do tenant com a chave. Conjunto pequeno (a frota), com teto visível. */
  app.get('/v1/roteamento/numeros', GESTAO, async (req, reply) => {
    const linhas = await req.comTenant((tx) => tx<{
      id: string; nome: string; tipo: string; filial_id: string | null; rodizio: boolean | null
    }[]>`
      SELECT cc.id, cc.nome_amigavel AS nome, cc.tipo, cc.filial_id, cfg.rodizio_na_entrada AS rodizio
        FROM canal_conectado cc
        LEFT JOIN canal_configuracao cfg ON cfg.tenant_id = cc.tenant_id AND cfg.canal_id = cc.id
       WHERE cc.tenant_id = tenant_atual()
       ORDER BY cc.nome_amigavel, cc.id
       LIMIT ${TETO_OPCOES + 1}`)
    const itens: NumeroRoteamento[] = linhas.slice(0, TETO_OPCOES).map((l) => ({
      id: l.id, nome: l.nome, tipo: l.tipo, filialId: l.filial_id, rodizioNaEntrada: l.rodizio ?? false,
    }))
    return reply.send({ itens, truncado: linhas.length > TETO_OPCOES })
  })

  app.put<{ Params: { id: string }; Body: { rodizioNaEntrada?: unknown } }>('/v1/roteamento/numeros/:id', EDICAO, async (req, reply) => {
    const canalId = req.params.id
    if (!UUID.test(canalId)) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
    const ligar = req.body?.rodizioNaEntrada
    if (typeof ligar !== 'boolean') {
      return reply.code(422).send({ erro: 'roteamento.invalido', mensagem: 'rodizioNaEntrada deve ser verdadeiro ou falso.', campos: ['rodizioNaEntrada'] })
    }
    const r = await req.comTenant(async (tx) => {
      const escopo = await escopoDaRequisicao(tx, req)
      const [c] = await tx<{ filial_id: string | null; antes: boolean | null }[]>`
        SELECT cc.filial_id, cfg.rodizio_na_entrada AS antes
          FROM canal_conectado cc
          LEFT JOIN canal_configuracao cfg ON cfg.tenant_id = cc.tenant_id AND cfg.canal_id = cc.id
         WHERE cc.tenant_id = tenant_atual() AND cc.id = ${canalId}`
      // Gestor de filial: só o número da filial dele (fora = 404, como inexistente).
      if (!c || (escopo.tipo !== 'tudo' && !(c.filial_id && filialNoEscopo(escopo, c.filial_id)))) return 'nao_encontrado' as const
      await tx`
        INSERT INTO canal_configuracao (tenant_id, canal_id, rodizio_na_entrada)
        VALUES (tenant_atual(), ${canalId}, ${ligar})
        ON CONFLICT (tenant_id, canal_id) DO UPDATE SET rodizio_na_entrada = EXCLUDED.rodizio_na_entrada`
      await auditar(tx, {
        atorId: await atorDaRequisicao(tx, req), atorStaff: req.atorStaff === true, acao: 'roteamento.rodizio_entrada_alterado',
        entidade: 'canal_conectado', entidadeId: canalId, dados: { antes: c.antes ?? false, depois: ligar },
      })
      return 'ok' as const
    })
    if (r === 'nao_encontrado') return reply.code(404).send({ erro: 'canal.nao_encontrado' })
    // Vale para os PRÓXIMOS contatos novos; ninguém que já existe muda de dono.
    return reply.send({ ok: true })
  })

  // ── apoio da tela ──────────────────────────────────────────────────────
  /** Filiais ATIVAS do escopo, para o select da regra. Conjunto pequeno, com teto visível. */
  app.get('/v1/roteamento/filiais', GESTAO, async (req, reply) => {
    const linhas = await req.comTenant(async (tx) => {
      const escopo = await escopoDaRequisicao(tx, req)
      const doEscopo = escopo.tipo === 'tudo' ? tx`true`
        : escopo.tipo === 'filial' ? tx`f.id = ANY(${[...escopo.filialIds]}::uuid[])` : tx`false`
      return tx<{ id: string; nome: string; cor: string | null }[]>`
        SELECT f.id, f.nome, f.cor FROM filial f
         WHERE f.tenant_id = tenant_atual() AND f.ativa AND ${doEscopo}
         ORDER BY f.nome, f.id
         LIMIT ${TETO_OPCOES + 1}`
    })
    return reply.send({ itens: linhas.slice(0, TETO_OPCOES), truncado: linhas.length > TETO_OPCOES })
  })

  // ── simulador ──────────────────────────────────────────────────────────
  app.get<{ Querystring: { telefone?: string; origemId?: string; canalId?: string } }>(
    '/v1/roteamento/simular', GESTAO, async (req, reply) => {
      const telefone = req.query.telefone?.trim() || null
      const origemId = req.query.origemId?.trim() || null
      const canalId = req.query.canalId?.trim() || null
      if (origemId && !UUID.test(origemId)) return reply.code(422).send({ erro: 'roteamento.origem_invalida', mensagem: 'Origem não encontrada.', campos: ['origemId'] })
      if (canalId && !UUID.test(canalId)) return reply.code(422).send({ erro: 'roteamento.numero_invalido', mensagem: 'Número não encontrado.', campos: ['canalId'] })
      if (!telefone && !origemId) {
        return reply.code(422).send({ erro: 'roteamento.simulacao_vazia', mensagem: 'Informe o telefone ou a origem.', campos: ['telefone'] })
      }
      const r = await req.comTenant(async (tx): Promise<SimulacaoRoteamento | Falha> => {
        let rodizioNaEntrada: boolean | null = null
        if (canalId) {
          const [c] = await tx<{ rodizio: boolean | null }[]>`
            SELECT cfg.rodizio_na_entrada AS rodizio FROM canal_conectado cc
              LEFT JOIN canal_configuracao cfg ON cfg.tenant_id = cc.tenant_id AND cfg.canal_id = cc.id
             WHERE cc.tenant_id = tenant_atual() AND cc.id = ${canalId}`
          if (!c) return falha(422, 'roteamento.numero_invalido', 'Número não encontrado.', ['canalId'])
          rodizioNaEntrada = c.rodizio ?? false
        }
        if (origemId) {
          const [o] = await tx`SELECT 1 FROM origem WHERE tenant_id = tenant_atual() AND id = ${origemId}`
          if (!o) return falha(422, 'roteamento.origem_invalida', 'Origem não encontrada.', ['origemId'])
        }
        const filial = await filialPorFatos(tx, { origemId, telefone, canalId })
        let nomeFilial: string | null = null
        let vendedor: SimulacaoRoteamento['vendedor'] = null
        let elegiveis = 0
        if (filial.filialId) {
          const [f] = await tx<{ nome: string }[]>`SELECT nome FROM filial WHERE tenant_id = tenant_atual() AND id = ${filial.filialId}`
          nomeFilial = f?.nome ?? null
          // ⚠️ avancar: false — só diz quem seria; nem trava nem grava o ponteiro.
          const v = await escolherVendedorDaFilial(tx, filial.filialId, canalId, { finalidade: 'entrada', avancar: false })
          elegiveis = v.elegiveis
          if (v.usuarioId) {
            const [u] = await tx<{ nome: string }[]>`SELECT nome FROM usuario WHERE tenant_id = tenant_atual() AND id = ${v.usuarioId}`
            vendedor = { id: v.usuarioId, nome: u?.nome ?? '' }
          }
        }
        return {
          ddd: filial.ddd,
          filial: filial.filialId && nomeFilial !== null ? { id: filial.filialId, nome: nomeFilial } : null,
          motivo: filial.motivo, regraId: filial.regraId, vendedor, elegiveis, rodizioNaEntrada,
        }
      })
      if (ehFalha(r)) return reply.code(r.status).send(r.corpo)
      return reply.send(r)
    },
  )
}
