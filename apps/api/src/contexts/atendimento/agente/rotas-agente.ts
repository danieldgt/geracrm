import type { FastifyInstance } from 'fastify'
import { REGRAS_AGENTE_PADRAO, validarRegrasAgente, type RegrasDoAgente } from '@geracrm/shared'
import { exigirTenant } from '../../../plugins/tenant.js'
import { faltaParaLlm } from './fabrica.js'

/**
 * A superfície do AGENTE SDR: ligar/desligar, escrever as políticas, e ver o que
 * o robô falou com os clientes.
 *
 * ⚠️ O painel de auditoria não é enfeite — é o invariante 6 do escopo. Sem ele,
 * "o que o robô disse para o meu cliente?" só teria resposta no log do
 * fornecedor de IA, que ninguém do time do cliente vai abrir.
 */

const PAGINA = 20

export async function rotasAgente(app: FastifyInstance): Promise<void> {
  /** Configuração do agente naquele número. */
  app.get<{ Params: { id: string } }>(
    '/v1/canais/:id/agente', { preHandler: exigirTenant },
    async (req, reply) => {
      const { cfg, temMensagemAusencia } = await req.comTenant(async (tx) => {
        const [linha] = await tx<{
          ativo: boolean; politicas: string | null
          so_quando_ninguem_disponivel: boolean; exigir_ausencia_antes: boolean
          horas_desde_ausencia: number; reabrir_apos_encerrada: boolean
          horas_para_reabrir: number
          minutos_presenca: number; max_turnos: number
          max_caracteres: number; falas_de_contexto: number
        }[]>`
          SELECT ativo, politicas,
                 so_quando_ninguem_disponivel, exigir_ausencia_antes,
                 horas_desde_ausencia, reabrir_apos_encerrada, horas_para_reabrir,
                 minutos_presenca, max_turnos, max_caracteres, falas_de_contexto
            FROM agente_config
           WHERE tenant_id = tenant_atual() AND canal_id = ${req.params.id}`
        // ⚠️ A tela precisa saber se existe mensagem de ausência NESTE número:
        //    com "esperar o cliente insistir" ligado (o padrão), o gatilho do
        //    agente é a ausência ter saído — e sem texto escrito ela nunca sai.
        //    O agente ficaria ligado e permanentemente mudo, sem nada na
        //    interface explicando por quê. É o mesmo tipo de dependência
        //    invisível que calou o agente em horário comercial até 01/09.
        const [canal] = await tx<{ tem: boolean }[]>`
          SELECT btrim(coalesce(mensagem_ausencia, '')) <> '' AS tem
            FROM canal_configuracao
           WHERE tenant_id = tenant_atual() AND canal_id = ${req.params.id}`
        return { cfg: linha, temMensagemAusencia: canal?.tem ?? false }
      })

      const p = REGRAS_AGENTE_PADRAO
      return reply.send({
        ativo: cfg?.ativo ?? false,
        politicas: cfg?.politicas ?? '',
        // ⚠️ Canal sem linha recebe os PADRÕES, não zeros: a tela abre já
        //    mostrando o agente que ele terá ao ser ligado, e não um formulário
        //    vazio que o dono teria de adivinhar como preencher.
        regras: {
          soQuandoNinguemDisponivel: cfg?.so_quando_ninguem_disponivel ?? p.soQuandoNinguemDisponivel,
          exigirAusenciaAntes: cfg?.exigir_ausencia_antes ?? p.exigirAusenciaAntes,
          horasDesdeAusencia: cfg?.horas_desde_ausencia ?? p.horasDesdeAusencia,
          reabrirAposEncerrada: cfg?.reabrir_apos_encerrada ?? p.reabrirAposEncerrada,
          horasParaReabrir: cfg?.horas_para_reabrir ?? p.horasParaReabrir,
          minutosPresenca: cfg?.minutos_presenca ?? p.minutosPresenca,
          maxTurnos: cfg?.max_turnos ?? p.maxTurnos,
          maxCaracteres: cfg?.max_caracteres ?? p.maxCaracteres,
          falasDeContexto: cfg?.falas_de_contexto ?? p.falasDeContexto,
        } satisfies RegrasDoAgente,
        // ⚠️ Os padrões vão junto para a tela poder oferecer "voltar ao padrão"
        //    sem ter uma segunda cópia deles em TypeScript do console.
        padroes: p,
        // ⚠️ COMPATIBILIDADE, remover no próximo deploy. `maxTurnos` mudou de
        //    lugar (foi para `regras`), e API e console sobem separados: na
        //    janela em que a API nova serve o console velho, tirar isto agora
        //    deixaria o campo em branco na tela. Mesma disciplina aditiva das
        //    migrations — mudar de lugar são dois deploys.
        maxTurnos: cfg?.max_turnos ?? p.maxTurnos,
        // ⚠️ A tela precisa dizer o NOME da variável que falta, não "IA
        //    indisponível": erro genérico manda abrir chamado, nome manda
        //    resolver.
        faltaConfigurar: faltaParaLlm(),
        /**
         * ⚠️ Sem isto, "esperar o cliente insistir depois da ausência" ligado
         * num canal sem mensagem de ausência é um agente que nunca abre a boca —
         * e o log diz `sem_ausencia_antes`, que soa como "ainda não chegou a
         * hora" e não como "falta configurar". A tela avisa antes.
         */
        temMensagemAusencia,
      })
    },
  )

  app.put<{
    Params: { id: string }
    Body: { ativo?: boolean; politicas?: string } & Partial<Record<keyof RegrasDoAgente, unknown>>
  }>(
    '/v1/canais/:id/agente', { preHandler: exigirTenant },
    async (req, reply) => {
      const politicas = req.body?.politicas?.trim() ?? ''
      const ativo = req.body?.ativo === true

      // ⚠️ A validação é a MESMA função que a tela usa (packages/shared): faixa
      //    duplicada entre input e endpoint é o clássico que aceita de um lado e
      //    recusa do outro. O CHECK do 0078 é a terceira rede, para o que não
      //    passa por aqui — script, teste, UPDATE à mão.
      const v = validarRegrasAgente({ ...req.body, maxTurnos: req.body?.maxTurnos })
      if (!v.ok) {
        return reply.code(422).send({
          erro: 'agente.regra_invalida',
          mensagem: v.erros[0]!.mensagem,
          campos: v.erros.map((e) => e.campo),
        })
      }
      const r = v.regras
      // ⚠️ Falha de negócio é retorno TIPIFICADO com ação corretiva, não erro de
      //    banco vazando para a tela. O CHECK do 0071 é a rede de segurança;
      //    esta é a mensagem que a pessoa lê.
      if (ativo && !politicas) {
        return reply.code(422).send({
          erro: 'agente.sem_politicas',
          mensagem: 'Escreva as políticas da loja antes de ligar o agente — sem elas ele responde "não sei" a tudo.',
        })
      }
      if (ativo && faltaParaLlm().length > 0) {
        return reply.code(422).send({
          erro: 'agente.sem_chave',
          mensagem: `Falta configurar ${faltaParaLlm().join(', ')} no servidor.`,
        })
      }

      const gravado = await req.comTenant(async (tx) => {
        const [canal] = await tx<{ id: string }[]>`
          SELECT id FROM canal_conectado WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!canal) return null
        await tx`
          INSERT INTO agente_config (
            tenant_id, canal_id, ativo, politicas, max_turnos,
            so_quando_ninguem_disponivel, exigir_ausencia_antes, horas_desde_ausencia,
            reabrir_apos_encerrada, horas_para_reabrir,
            minutos_presenca, max_caracteres, falas_de_contexto,
            atualizado_em)
          VALUES (tenant_atual(), ${req.params.id}, ${ativo}, ${politicas || null}, ${r.maxTurnos},
                  ${r.soQuandoNinguemDisponivel}, ${r.exigirAusenciaAntes}, ${r.horasDesdeAusencia},
                  ${r.reabrirAposEncerrada}, ${r.horasParaReabrir},
                  ${r.minutosPresenca}, ${r.maxCaracteres}, ${r.falasDeContexto},
                  now())
          ON CONFLICT (tenant_id, canal_id) DO UPDATE SET
            ativo = EXCLUDED.ativo, politicas = EXCLUDED.politicas,
            max_turnos = EXCLUDED.max_turnos,
            so_quando_ninguem_disponivel = EXCLUDED.so_quando_ninguem_disponivel,
            exigir_ausencia_antes = EXCLUDED.exigir_ausencia_antes,
            horas_desde_ausencia = EXCLUDED.horas_desde_ausencia,
            reabrir_apos_encerrada = EXCLUDED.reabrir_apos_encerrada,
            horas_para_reabrir = EXCLUDED.horas_para_reabrir,
            minutos_presenca = EXCLUDED.minutos_presenca,
            max_caracteres = EXCLUDED.max_caracteres,
            falas_de_contexto = EXCLUDED.falas_de_contexto,
            atualizado_em = now()`
        return canal
      })
      if (!gravado) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      return reply.send({ ok: true })
    },
  )

  /**
   * O que o agente conduziu — a entrega ao humano.
   *
   * ⚠️ Paginado por CURSOR, como toda lista do produto: `top-N` cru e OFFSET
   * profundo já derrubaram um Postgres desta casa em horário comercial.
   */
  app.get<{ Querystring: { cursor?: string } }>(
    '/v1/agente/sessoes', { preHandler: exigirTenant },
    async (req, reply) => {
      let curEm: string | null = null, curId: string | null = null
      if (req.query.cursor) {
        const [em, id] = Buffer.from(req.query.cursor, 'base64url').toString('utf8').split('§')
        if (!em || !id) return reply.code(422).send({ erro: 'cursor.invalido' })
        curEm = em; curId = id
      }

      const linhas = await req.comTenant((tx) => tx<{
        id: string; conversa_id: string; contato: string | null
        estado: string; turnos: number; motivo_saida: string | null
        iniciada_em: Date; encerrada_em: Date | null
        extraido: Record<string, unknown>; descartados: unknown[]
        tokens_entrada: number; tokens_saida: number
      }[]>`
        SELECT s.id, s.conversa_id, ct.nome AS contato, s.estado, s.turnos, s.motivo_saida,
               s.iniciada_em, s.encerrada_em, s.extraido, s.descartados,
               s.tokens_entrada, s.tokens_saida
          FROM agente_sessao s
          JOIN conversa cv ON cv.tenant_id = s.tenant_id AND cv.id = s.conversa_id
          LEFT JOIN contato ct ON ct.tenant_id = cv.tenant_id AND ct.id = cv.contato_id
         WHERE s.tenant_id = tenant_atual()
           AND ${curEm === null ? tx`true` : tx`(s.iniciada_em, s.id) < (${curEm}::timestamptz, ${curId}::uuid)`}
         ORDER BY s.iniciada_em DESC, s.id DESC LIMIT ${PAGINA + 1}`)

      const temMais = linhas.length > PAGINA
      const pagina = temMais ? linhas.slice(0, PAGINA) : linhas
      const ultimo = pagina[pagina.length - 1]

      return reply.send({
        itens: pagina.map((l) => ({
          id: l.id, conversaId: l.conversa_id, contato: l.contato,
          estado: l.estado, turnos: l.turnos, motivoSaida: l.motivo_saida,
          iniciadaEm: l.iniciada_em, encerradaEm: l.encerrada_em,
          extraido: l.extraido, descartados: l.descartados,
          // ⚠️ O custo aparece por sessão, na tela de quem paga a conta.
          tokens: l.tokens_entrada + l.tokens_saida,
        })),
        proximoCursor: temMais && ultimo
          ? Buffer.from(`${ultimo.iniciada_em.toISOString()}§${ultimo.id}`).toString('base64url') : null,
      })
    },
  )
}
