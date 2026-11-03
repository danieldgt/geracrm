import type { FastifyInstance, FastifyRequest } from 'fastify'
import { exigirTenant, subDoUsuario } from '../../plugins/tenant.js'
import { atendePapel, exigirPapel, papeisDoUsuario } from './papel.js'
import { fusoValido } from './fuso.js'
import { garantirUsuarioId } from '../atendimento/rotas-fila.js'
import { auditar } from './auditoria.js'
import { listarModulos, moduloAtivo } from './modulos.js'
import { ehModulo, validarEmpresa, type CorpoEmpresa, type EmpresaContatoLgpd } from '@geracrm/shared'
import type { Sql } from '../../db/index.js'

type EmpresaLida = EmpresaContatoLgpd & { plano: string }

/** A empresa do tenant da transação, já no formato da API (camelCase, endereço como objeto). */
async function lerEmpresa(tx: Sql): Promise<EmpresaLida | null> {
  const [e] = await tx<{
    nome: string; fuso: string; plano: string; cnpj: string | null; telefone: string | null; whatsapp: string | null
    email: string | null; site: string | null; endereco: EmpresaContatoLgpd['endereco']
    dpo_nome: string | null; dpo_email: string | null; retencao_meses: number
    texto_consentimento: string | null; exigir_consentimento_whatsapp: boolean
  }[]>`
    SELECT t.nome, t.fuso, p.codigo AS plano, t.cnpj, t.telefone, t.whatsapp, t.email, t.site, t.endereco,
           t.dpo_nome, t.dpo_email, t.retencao_meses, t.texto_consentimento, t.exigir_consentimento_whatsapp
      FROM tenant t JOIN plano p ON p.id = t.plano_id
     WHERE t.id = tenant_atual()`
  if (!e) return null
  return {
    nome: e.nome, fuso: e.fuso, plano: e.plano, cnpj: e.cnpj, telefone: e.telefone, whatsapp: e.whatsapp,
    email: e.email, site: e.site, endereco: e.endereco ?? null, dpoNome: e.dpo_nome, dpoEmail: e.dpo_email,
    retencaoMeses: e.retencao_meses, textoConsentimento: e.texto_consentimento,
    exigirConsentimentoWhatsapp: e.exigir_consentimento_whatsapp,
  }
}

/** A linha de `usuario` nasce no batimento; garantir antes de `exigirPapel` (mesmo padrão das rotas do agente). */
async function garantirUsuario(req: FastifyRequest): Promise<void> {
  if (req.tenantId) await req.comTenant((tx) => garantirUsuarioId(tx, req))
}

/**
 * Configurações Gerais — a empresa (nome, fuso, plano) e a equipe com os papéis.
 * ⚠️ Papel é POR FILIAL (usuario_filial), nunca global — a mesma pessoa pode ser
 * gestora numa filial e atendente em outra. A gestão de usuários/papéis (criar,
 * conceder) é de identidade/acesso e não entra aqui; esta tela MOSTRA e deixa
 * editar só os dados da própria empresa. Tenant sempre de tenant_atual() (ADR-001).
 */
export async function rotasConfig(app: FastifyInstance): Promise<void> {
  app.get('/v1/config/empresa', { preHandler: exigirTenant }, async (req, reply) => {
    const e = await req.comTenant((tx) => lerEmpresa(tx))
    if (!e) return reply.code(404).send({ erro: 'empresa.nao_encontrada' })
    return reply.send(e)
  })

  app.patch<{ Body: CorpoEmpresa }>(
    // ⚠️ Admin: o fuso decide o expediente, a ausência e o recorte do agente de todos os números;
    //    LGPD e contato são dados que a empresa responde por.
    '/v1/config/empresa', { preHandler: [exigirTenant, garantirUsuario, exigirPapel('admin')] },
    async (req, reply) => {
      // ⚠️ Fuso IANA de verdade: um texto qualquer derrubava toda consulta com AT TIME ZONE.
      const v = validarEmpresa(req.body ?? {}, fusoValido)
      if (!v.ok) {
        return reply.code(422).send({ erro: 'validacao', mensagem: 'Corrija os campos destacados.', campos: v.campos })
      }
      const novos = v.valores
      const resultado = await req.comTenant(async (tx) => {
        const atual = await lerEmpresa(tx)
        if (!atual) return null
        const m = { ...atual, ...novos }
        await tx`
          UPDATE tenant SET
            nome = ${m.nome}, fuso = ${m.fuso}, cnpj = ${m.cnpj}, telefone = ${m.telefone}, whatsapp = ${m.whatsapp},
            email = ${m.email}, site = ${m.site},
            endereco = ${m.endereco === null ? null : JSON.stringify(m.endereco)}::text::jsonb,
            dpo_nome = ${m.dpoNome}, dpo_email = ${m.dpoEmail}, retencao_meses = ${m.retencaoMeses},
            texto_consentimento = ${m.textoConsentimento},
            exigir_consentimento_whatsapp = ${m.exigirConsentimentoWhatsapp}
           WHERE id = tenant_atual()`
        // Só os NOMES dos campos vão para a trilha: CNPJ e e-mail não precisam morar duas vezes.
        await auditar(tx, {
          atorId: req.atorStaff ? null : await garantirUsuarioId(tx, req), atorStaff: req.atorStaff ?? false,
          acao: 'empresa.alterada', entidade: 'tenant', dados: { campos: Object.keys(novos) },
        })
        return true
      })
      if (!resultado) return reply.code(404).send({ erro: 'empresa.nao_encontrada' })
      return reply.send({ ok: true })
    },
  )

  // Chaves de módulo: todos leem (o menu precisa saber); só admin liga/desliga.
  app.get('/v1/config/modulos', { preHandler: exigirTenant }, async (req, reply) => {
    const modulos = await req.comTenant((tx) => listarModulos(tx))
    return reply.send({ modulos })
  })

  app.put<{ Params: { modulo: string }; Body: { ativo?: unknown } }>(
    '/v1/config/modulos/:modulo', { preHandler: [exigirTenant, garantirUsuario, exigirPapel('admin')] },
    async (req, reply) => {
      const { modulo } = req.params
      if (!ehModulo(modulo)) return reply.code(404).send({ erro: 'modulo.desconhecido', mensagem: 'Módulo desconhecido.' })
      const ativo = req.body?.ativo
      if (typeof ativo !== 'boolean') {
        return reply.code(422).send({ erro: 'validacao', mensagem: 'Informe se o módulo fica ligado.', campos: { ativo: 'Informe sim ou não.' } })
      }
      const modulos = await req.comTenant(async (tx) => {
        const atorId = req.atorStaff ? null : await garantirUsuarioId(tx, req)
        const antes = await moduloAtivo(tx, modulo)
        await tx`
          INSERT INTO tenant_modulo (tenant_id, modulo, ativo, atualizado_em, atualizado_por)
          VALUES (tenant_atual(), ${modulo}, ${ativo}, now(), ${atorId})
          ON CONFLICT (tenant_id, modulo) DO UPDATE
            SET ativo = EXCLUDED.ativo, atualizado_em = now(), atualizado_por = EXCLUDED.atualizado_por`
        await auditar(tx, {
          atorId, atorStaff: req.atorStaff ?? false, acao: 'modulo.alterado', entidade: 'tenant_modulo',
          dados: { modulo, antes, depois: ativo },
        })
        return listarModulos(tx)
      })
      return reply.send({ modulos })
    },
  )

  // Equipe: usuários com seus papéis por filial (leitura).
  app.get('/v1/config/equipe', { preHandler: exigirTenant }, async (req, reply) => {
    const linhas = await req.comTenant((tx) => tx<{
      id: string; nome: string; email: string | null; ativo: boolean
      ausente: boolean; visto_em: Date | null; canais: number
      papeis: { papel: string; filial: string }[]
    }[]>`
      SELECT u.id, u.nome, u.email, u.ativo, u.ausente, u.visto_em,
             -- ⚠️ tenant_atual(), e NÃO u.tenant_id: a coluna do outer query não
             --    está no GROUP BY e o Postgres recusa ("subquery uses ungrouped
             --    column"). O valor é o mesmo — a consulta já roda sob RLS do
             --    tenant do token (ADR-001).
             (SELECT count(*)::int FROM usuario_canal uc2
               WHERE uc2.tenant_id = tenant_atual() AND uc2.usuario_id = u.id) AS canais,
             COALESCE(
               json_agg(json_build_object('papel', uf.papel, 'filial', COALESCE(f.nome, 'Todas as filiais'))
                        ORDER BY uf.papel) FILTER (WHERE uf.papel IS NOT NULL),
               '[]'::json) AS papeis
        FROM usuario u
        LEFT JOIN usuario_filial uf ON uf.tenant_id = u.tenant_id AND uf.usuario_id = u.id
        LEFT JOIN filial f ON f.tenant_id = uf.tenant_id AND f.id = uf.filial_id
       WHERE u.tenant_id = tenant_atual()
       GROUP BY u.id, u.nome, u.email, u.ativo, u.ausente, u.visto_em
       ORDER BY u.ativo DESC, u.nome ASC
       LIMIT 200`)
    return reply.send({
      itens: linhas.map((l) => ({
        id: l.id, nome: l.nome, email: l.email, ativo: l.ativo, papeis: l.papeis,
        ausente: l.ausente,
        // ⚠️ Vai o CARIMBO, não um booleano "online": a tela mostra "visto há 3
        //    min" e quem lê decide. Booleano esconde o quanto a informação já
        //    envelheceu — o mesmo erro do estado de canal sem carimbo (0069).
        vistoEm: l.visto_em,
        canais: l.canais,
      })),
    })
  })

  /**
   * EU — o meu próprio estado de presença.
   *
   * ⚠️ Existe porque a tela casava o próprio usuário por E-MAIL dentro da lista
   * da equipe (`/v1/config/equipe`), o que é errado em dois sentidos: traz até
   * 200 linhas de gente para ler um booleano meu, e erra quando o e-mail do
   * token não bate exatamente com o gravado. Aqui o servidor responde sobre
   * quem o TOKEN identifica, que é a única resposta que não depende de sorte.
   *
   * ⚠️ Sem linha é DISPONÍVEL — quem nunca abriu o menu atende normalmente.
   */
  app.get('/v1/config/eu', { preHandler: exigirTenant }, async (req, reply) => {
    const sub = subDoUsuario(req)
    const { u, gestao, admin } = await req.comTenant(async (tx) => {
      const [linha] = await tx<{ nome: string; email: string | null; ausente: boolean }[]>`
        SELECT nome, email, ausente FROM usuario
         WHERE tenant_id = tenant_atual() AND cognito_sub = ${sub}`
      // Só para a tela decidir o que MOSTRAR (ex.: Reatribuir); quem barra é o servidor em cada rota.
      const acesso = await papeisDoUsuario(tx, { sub, atorStaff: req.atorStaff })
      return { u: linha, gestao: atendePapel(acesso, ['gestor', 'supervisor']), admin: atendePapel(acesso, []) }
    })
    return reply.send({
      nome: u?.nome ?? null, email: u?.email ?? null, ausente: u?.ausente === true, gestao, admin,
    })
  })

  /**
   * BATIMENTO — o console avisa que a pessoa está ali.
   *
   * ⚠️ É o que separa "ninguém logado" de "todo mundo logado": fechar o
   * navegador não avisa ninguém, então a AUSÊNCIA de sinal é o sinal. Sem isto,
   * o produto acharia que há gente na mesa a noite inteira e o agente nunca
   * assumiria (`disponibilidade.ts`).
   */
  app.post('/v1/config/presenca', { preHandler: exigirTenant }, async (req, reply) => {
    // ⚠️ Casa por `cognito_sub`: é quem o token identifica. Aceitar um id vindo
    //    do corpo deixaria um usuário marcar presença por outro.
    const sub = subDoUsuario(req)
    await req.comTenant((tx) => tx`
      UPDATE usuario SET visto_em = now()
       WHERE tenant_id = tenant_atual() AND cognito_sub = ${sub}`)
    return reply.send({ ok: true })
  })

  /**
   * O usuário se marca ausente (ou volta).
   *
   * ⚠️ Só sobre SI MESMO. Marcar outra pessoa como ausente seria decidir por ela
   * que o robô assume as conversas dela — e a pessoa descobriria pelo cliente.
   */
  app.patch<{ Body: { ausente?: boolean } }>(
    '/v1/config/ausencia', { preHandler: exigirTenant },
    async (req, reply) => {
      const ausente = req.body?.ausente === true
      // ⚠️ Mesmo `sub` que o envio e o assumir consultam. Quando isto exigia
      //    token, o dev local gravava por um caminho e lia por outro: o botão
      //    voltava sozinho ao estado anterior e ninguém entendia por quê.
      const sub = subDoUsuario(req)
      // ⚠️ Voltar de ausente também é sinal de vida: quem clicou está ali.
      await req.comTenant((tx) => tx`
        UPDATE usuario
           SET ausente = ${ausente},
               visto_em = CASE WHEN ${ausente} THEN visto_em ELSE now() END
         WHERE tenant_id = tenant_atual() AND cognito_sub = ${sub}`)
      return reply.send({ ok: true, ausente })
    },
  )
}
