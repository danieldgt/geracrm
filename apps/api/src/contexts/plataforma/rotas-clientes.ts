import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { exigirStaff, exigirTenant } from '../../plugins/tenant.js'
import { sql, comTenantServico } from '../../db/index.js'
import { auditar } from './auditoria.js'
import { garantirUsuarioId } from '../atendimento/rotas-fila.js'
import { MODELOS_FUNIL, ehModeloFunil, MODELO_FUNIL_PADRAO, garantirEtapasFunil } from '../crm/funil-modelos.js'
import { cognitoAdminConfigurado, criarUsuarioCognito, EmailJaExiste, CognitoAdminIndisponivel } from '../identidade/cognito-admin.js'

/**
 * Cadastro de CLIENTES pelo staff (a tela "Clientes" da Plataforma).
 *
 * ⚠️ São as únicas rotas do produto que operam fora do escopo de um tenant —
 * criar um tenant não pode vir de dentro dele. Duas consequências, e as duas
 * estão implementadas aqui:
 *
 *   1. Toda rota exige `exigirStaff` (grupo `staff` do Cognito) ALÉM de
 *      `exigirTenant`. As funções `criar_tenant`/`listar_tenants` (migration
 *      0080) são SECURITY DEFINER e não checam chamador — este guard é a única
 *      autorização que existe.
 *   2. O corpo NUNCA carrega `tenantId`. O id do cliente é gerado pelo banco;
 *      aceitar um id de fora seria exatamente o buraco que o ADR-001 fecha (e o
 *      varredor INV-02 derruba o CI se aparecer um `tenantId` em `z.object`).
 *
 * ⚠️ Ordem obrigatória: o tenant nasce ANTES do login, porque `custom:tenant_id`
 * precisa do id. Se o Cognito falhar depois disso, o cliente fica criado e SEM
 * login — a resposta diz isso em vez de fingir sucesso, e o staff cria o login à
 * mão. Não desfazemos o tenant: uma função de apagar tenant seria uma superfície
 * destrutiva bem mais perigosa do que o caso que ela resolveria.
 */

const FUSO_PADRAO = 'America/Sao_Paulo'

/** Senha inicial forte, mostrada UMA vez (mesmo padrão do segredo de webhook). */
function senhaInicial(): string {
  // base64url de 18 bytes + sufixo fixo: cobre maiúscula/minúscula/dígito/símbolo
  // exigidos por qualquer política de senha do pool.
  return `${randomBytes(18).toString('base64url')}#7aA`
}

interface LinhaTenant {
  id: string; nome: string; fuso: string; ativo: boolean; criado_em: Date; plano: string
}

export async function rotasClientes(app: FastifyInstance): Promise<void> {
  /** O que o formulário precisa oferecer: planos, verticais e modelos de funil. */
  app.get('/v1/plataforma/opcoes', { preHandler: [exigirTenant, exigirStaff] }, async (_req, reply) => {
    const [planos, verticais] = await Promise.all([
      sql<{ codigo: string; nome: string }[]>`SELECT codigo, nome FROM plano ORDER BY nome`,
      sql<{ codigo: string; nome: string }[]>`SELECT codigo, nome FROM perfil_vertical_modelo ORDER BY nome`,
    ])
    return reply.send({
      planos, verticais,
      modelosFunil: Object.entries(MODELOS_FUNIL).map(([codigo, m]) => ({
        codigo, nome: m.nome, descricao: m.descricao,
        etapas: m.etapas.map((e) => ({ nome: e.nome, tipo: e.tipo })),
      })),
      podeCriarLogin: cognitoAdminConfigurado(),
    })
  })

  app.get('/v1/plataforma/clientes', { preHandler: [exigirTenant, exigirStaff] }, async (_req, reply) => {
    const linhas = await sql<LinhaTenant[]>`SELECT * FROM listar_tenants()`
    return reply.send({
      itens: linhas.map((t) => ({
        id: t.id, nome: t.nome, fuso: t.fuso, ativo: t.ativo, criadoEm: t.criado_em, plano: t.plano,
      })),
    })
  })

  app.post<{
    Body: {
      nome?: string; fuso?: string; planoCodigo?: string; verticalCodigo?: string
      modeloFunil?: string; admin?: { nome?: string; email?: string }
    }
  }>('/v1/plataforma/clientes', { preHandler: [exigirTenant, exigirStaff] }, async (req, reply) => {
    const b = req.body ?? {}
    const nome = b.nome?.trim()
    const planoCodigo = b.planoCodigo?.trim()
    const verticalCodigo = b.verticalCodigo?.trim()
    const adminNome = b.admin?.nome?.trim()
    const adminEmail = b.admin?.email?.trim().toLowerCase()

    if (!nome) return reply.code(422).send({ erro: 'cliente.nome_obrigatorio', mensagem: 'Informe o nome do cliente.' })
    if (!planoCodigo) return reply.code(422).send({ erro: 'cliente.plano_obrigatorio', mensagem: 'Escolha o plano.' })
    if (!verticalCodigo) return reply.code(422).send({ erro: 'cliente.vertical_obrigatoria', mensagem: 'Escolha o perfil de vertical.' })
    if (!ehModeloFunil(b.modeloFunil ?? MODELO_FUNIL_PADRAO)) {
      return reply.code(422).send({ erro: 'cliente.modelo_funil_invalido', mensagem: 'Modelo de funil desconhecido.' })
    }
    const modeloFunil = ehModeloFunil(b.modeloFunil) ? b.modeloFunil : MODELO_FUNIL_PADRAO
    if (adminEmail && !adminNome) {
      return reply.code(422).send({ erro: 'cliente.admin_nome_obrigatorio', mensagem: 'Informe o nome de quem vai acessar.' })
    }
    if (adminEmail && !cognitoAdminConfigurado()) {
      // ⚠️ Checado ANTES de criar o tenant: é a falha mais provável, e falhar
      //    aqui não deixa cliente órfão.
      return reply.code(503).send({ erro: 'cliente.login_indisponivel',
        mensagem: 'A API não está configurada para criar logins. Cadastre sem login ou configure as credenciais.' })
    }

    // ── 1. tenant + perfil vertical (SECURITY DEFINER, migration 0080) ──
    let tenantId: string
    try {
      const [linha] = await sql<{ criar_tenant: string }[]>`
        SELECT criar_tenant(${nome}, ${b.fuso?.trim() || FUSO_PADRAO}, ${planoCodigo}, ${verticalCodigo})`
      tenantId = linha!.criar_tenant
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      if (msg.includes('plano_nao_encontrado')) {
        return reply.code(422).send({ erro: 'cliente.plano_nao_encontrado', mensagem: 'Plano não encontrado.' })
      }
      if (msg.includes('modelo_nao_encontrado')) {
        return reply.code(422).send({ erro: 'cliente.vertical_nao_encontrada', mensagem: 'Perfil de vertical não encontrado.' })
      }
      throw e
    }

    // ── 2. o funil do cliente, no modelo escolhido ──
    await comTenantServico(tenantId, (tx) => garantirEtapasFunil(tx, modeloFunil))

    // ── 3. login (opcional) ──
    let login: { criado: boolean; email?: string; senha?: string; erro?: string } = { criado: false }
    if (adminEmail && adminNome) {
      const senha = senhaInicial()
      try {
        await criarUsuarioCognito({ email: adminEmail, nome: adminNome, tenantId, senha })
        login = { criado: true, email: adminEmail, senha }
      } catch (e) {
        // ⚠️ O cliente JÁ existe neste ponto. Dizer a verdade vale mais que um
        //    500 que esconde um tenant criado pela metade.
        login = {
          criado: false,
          erro: e instanceof EmailJaExiste
            ? 'Este e-mail já tem login no sistema. Use outro endereço — o vínculo com a empresa não pode ser alterado depois.'
            : e instanceof CognitoAdminIndisponivel
              ? 'A API não está configurada para criar logins.'
              : 'O cliente foi criado, mas o login falhou. Crie o acesso manualmente.',
        }
        req.log.error({ erro: e instanceof Error ? e.message : String(e), tenantId }, 'falha ao criar login do cliente')
      }
    }

    // ── 4. trilha: fica no tenant de QUEM criou ──
    await req.comTenant(async (tx) => {
      await auditar(tx, {
        atorId: await garantirUsuarioId(tx, req),
        acao: 'cliente.criado', entidade: 'tenant', entidadeId: tenantId,
        dados: { nome, planoCodigo, verticalCodigo, modeloFunil, loginCriado: login.criado },
      })
    })

    return reply.code(201).send({ id: tenantId, nome, modeloFunil, login })
  })
}
