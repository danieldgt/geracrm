import { randomUUID } from 'node:crypto'
import {
  DIAS_MAX_REUNIAO, DURACAO_REUNIAO_PADRAO, OPCOES_POR_OFERTA, VALIDADE_OFERTA_HORAS, interpretarEscolhaDeHorario,
  type HorarioLivre, type OpcaoOfertada,
} from '@geracrm/shared'
import { comTenantServico, type Sql } from '../../../../db/index.js'
import { partesLocais } from '../../expediente.js'
import {
  agendarReuniao, diaLocal, horariosLivresDoDia, lerExpedienteReuniao, vendedoresParaReuniao,
} from '../../../crm/reuniao.js'
import type { AgendaPorta, OpcaoParaLlm, QuandoLocal } from './ligacoes-porta.js'

/**
 * A AGENDA REAL do agente (C3) — sobre o caso de uso público `crm/reuniao.ts`, o mesmo do
 * botão do inbox. Roda como serviço (`comTenantServico`): o agente é máquina, sem escopo.
 *
 * ⚠️ O agente NUNCA transfere carteira (decisão do orquestrador): se o dono não tem horário, a
 *    reunião pode ser com outro vendedor da filial, que fica responsável pela REUNIÃO; o feed
 *    registra que o responsável pelo contato continua o mesmo.
 */

/** Sem dia pedido, procura nos próximos dias (hoje incluso) até achar opções. */
const DIAS_DE_BUSCA = 7
/** Quantas pessoas da filial tentar antes de desistir (o responsável é a primeira). */
const VENDEDORES_TENTADOS = 5
/** Entre duas opções do mesmo dia, pelo menos isto — o cliente escolhe entre horas diferentes. */
const INTERVALO_ENTRE_OPCOES_MIN = 120
const POR_DIA = 2
/** B6: no máximo isto de ofertas por conversa em 24 h (cliente que nunca escolhe não gera oferta sem fim). */
export const OFERTAS_MAX_DIA = 5
const DIAS_SEMANA = ['', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom']

function somarDias(dia: string, n: number): string {
  const [y, m, d] = dia.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/** Até `POR_DIA` horários do dia, espaçados (manhã e tarde em vez de 09:00, 09:30, 10:00). */
function espalhar(horarios: readonly HorarioLivre[], max: number): HorarioLivre[] {
  const saida: HorarioLivre[] = []
  for (const h of horarios) {
    if (saida.length >= Math.min(max, POR_DIA)) break
    const ultimo = saida[saida.length - 1]
    if (!ultimo || Date.parse(h.inicio) - Date.parse(ultimo.inicio) >= INTERVALO_ENTRE_OPCOES_MIN * 60_000) saida.push(h)
  }
  return saida
}

const primeiroNome = (nome: string): string => nome.trim().split(/\s+/)[0] ?? nome
const local = (iso: string, fuso: string): QuandoLocal => {
  const p = partesLocais(new Date(iso), fuso)
  return { data: p.data, hora: p.hora, diaIso: p.diaIso }
}
const rotulo = (l: QuandoLocal): string => `${DIAS_SEMANA[l.diaIso] ?? ''}, ${l.data.slice(8, 10)}/${l.data.slice(5, 7)} às ${l.hora}`

/** M7: reunião FUTURA já nascida nesta conversa (remarcação é com uma pessoa). */
async function reuniaoFutura(tx: Sql, conversaId: string, agora: Date, fuso: string): Promise<string | null> {
  const [e] = await tx<{ inicio: Date }[]>`
    SELECT inicio FROM evento_agenda
     WHERE tenant_id = tenant_atual() AND conversa_id = ${conversaId} AND status = 'agendado' AND inicio > ${agora}
     ORDER BY inicio LIMIT 1`
  return e ? rotulo(local(e.inicio.toISOString(), fuso)) : null
}

export const agendaReal: AgendaPorta = {
  async ofertar(ctx, p) {
    return comTenantServico(ctx.tenantId, async (tx) => {
      const exp = await lerExpedienteReuniao(tx, ctx.canalId)
      const futura = await reuniaoFutura(tx, ctx.conversaId, ctx.agora, exp.fuso)
      if (futura) return { situacao: 'ja_tem_reuniao' as const, quando: futura }
      if (p.real) {
        const [n] = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM reuniao_oferta
           WHERE tenant_id = tenant_atual() AND conversa_id = ${ctx.conversaId} AND ofertada_em > ${new Date(ctx.agora.getTime() - 86_400_000)}`
        if ((n?.n ?? 0) >= OFERTAS_MAX_DIA) return { situacao: 'limite_ofertas' as const }
      }
      const hoje = diaLocal(ctx.agora, exp.fuso)
      let dias: string[]
      if (p.dia) {
        const delta = (Date.parse(p.dia) - Date.parse(hoje)) / 86_400_000
        if (Number.isNaN(delta) || delta < 0 || delta > DIAS_MAX_REUNIAO) return { situacao: 'dia_invalido' as const }
        dias = [p.dia]
      } else {
        dias = Array.from({ length: DIAS_DE_BUSCA }, (_, i) => somarDias(hoje, i))
      }
      // M3: dono ausente já sai da lista (cai para a filial).
      const { itens } = await vendedoresParaReuniao(tx, { contatoId: ctx.contatoId, canalId: ctx.canalId })
      if (itens.length === 0) return { situacao: 'sem_vendedor' as const }

      // Responsável do contato primeiro; só se ele não tiver horário, o próximo da filial.
      for (const v of itens.slice(0, VENDEDORES_TENTADOS)) {
        const escolhidos: HorarioLivre[] = []
        for (const d of dias) {
          const r = await horariosLivresDoDia(tx, { usuarioId: v.usuarioId, dia: d, canalId: ctx.canalId, duracaoMin: DURACAO_REUNIAO_PADRAO, agora: ctx.agora })
          escolhidos.push(...espalhar(r.horarios, OPCOES_POR_OFERTA - escolhidos.length))
          if (escolhidos.length >= OPCOES_POR_OFERTA) break
        }
        if (escolhidos.length === 0) continue
        const ofertadas: OpcaoOfertada[] = escolhidos.map((h, i) => {
          const l = local(h.inicio, exp.fuso)
          return { n: i + 1, usuarioId: v.usuarioId, inicio: h.inicio, fim: h.fim, hora: l.hora, data: l.data }
        })
        const opcoes: (OpcaoParaLlm & QuandoLocal)[] = ofertadas.map((o) => {
          const l = local(o.inicio, exp.fuso)
          return { n: o.n, quando: rotulo(l), com: primeiroNome(v.nome), ...l }
        })
        // ⚠️ Só a oferta do autônomo é gravada — e ainda NÃO vale: o pós-envio do turno a marca
        //    `enviada_em` quando a mensagem com as linhas chega ao gateway (A3).
        let ofertaId: string | null = null
        if (p.real) {
          ofertaId = randomUUID()
          await tx`
            INSERT INTO reuniao_oferta (tenant_id, id, conversa_id, contato_id, canal_id, opcoes, ofertada_em, expira_em)
            VALUES (tenant_atual(), ${ofertaId}, ${ctx.conversaId}, ${ctx.contatoId}, ${ctx.canalId},
                    ${JSON.stringify(ofertadas)}::text::jsonb, ${ctx.agora},
                    ${new Date(ctx.agora.getTime() + VALIDADE_OFERTA_HORAS * 3_600_000)})`
        }
        return { situacao: 'ok' as const, opcoes, ofertaId }
      }
      return { situacao: 'sem_horarios' as const }
    })
  },

  async confirmar(ctx, p) {
    return comTenantServico(ctx.tenantId, async (tx) => {
      const exp = await lerExpedienteReuniao(tx, ctx.canalId)
      const [o] = await tx<{ id: string; opcoes: OpcaoOfertada[]; ofertada_em: Date; expira_em: Date; confirmada_em: Date | null; enviada_em: Date | null }[]>`
        SELECT id, opcoes, ofertada_em, expira_em, confirmada_em, enviada_em FROM reuniao_oferta
         WHERE tenant_id = tenant_atual() AND conversa_id = ${ctx.conversaId}
         ORDER BY ofertada_em DESC LIMIT 1 FOR UPDATE`
      if (!o) return { situacao: 'sem_oferta' as const }
      if (o.confirmada_em) return { situacao: 'ja_confirmada' as const }
      // ⚠️ Oferta deste mesmo turno: o cliente ainda não leu — não há "sim" possível.
      if (o.ofertada_em.getTime() >= ctx.agora.getTime()) return { situacao: 'mesmo_turno' as const }
      // ⚠️ A3: oferta cujo texto não chegou ao cliente (turno barrado, envio recusado) não confirma.
      if (!o.enviada_em) return { situacao: 'oferta_nao_enviada' as const }
      if (o.expira_em.getTime() <= ctx.agora.getTime()) return { situacao: 'oferta_vencida' as const }
      const futura = await reuniaoFutura(tx, ctx.conversaId, ctx.agora, exp.fuso)
      if (futura) return { situacao: 'ja_tem_reuniao' as const, quando: futura }
      const opcao = o.opcoes.find((x) => x.n === p.opcao)
      if (!opcao) return { situacao: 'opcao_inexistente' as const }

      // ⚠️ A confirmação EXPLÍCITA do cliente é conferida AQUI, em código, e só na mensagem MAIS
      //    RECENTE dele depois da oferta (A2): "2" seguido de "prefiro amanhã" não confirma.
      const [m] = await tx<{ texto: string | null }[]>`
        SELECT conteudo->>'texto' AS texto FROM mensagem
         WHERE tenant_id = tenant_atual() AND conversa_id = ${ctx.conversaId} AND direcao = 'entrante'
           AND criado_em > ${o.ofertada_em}
         ORDER BY criado_em DESC LIMIT 1`
      const escolha = interpretarEscolhaDeHorario(m?.texto ?? '', o.opcoes)
      if (escolha.tipo === 'recusou') return { situacao: 'cliente_recusou' as const }
      if (escolha.tipo === 'indefinido') return { situacao: 'sem_confirmacao' as const }
      if (escolha.n !== p.opcao) return { situacao: 'confirmacao_divergente' as const }

      const [c] = await tx<{ nome: string }[]>`SELECT nome FROM contato WHERE tenant_id = tenant_atual() AND id = ${ctx.contatoId}`
      const r = await agendarReuniao(tx, {
        conversaId: ctx.conversaId, usuarioId: opcao.usuarioId, inicio: new Date(opcao.inicio), fim: new Date(opcao.fim),
        titulo: `Reunião com ${c?.nome ?? 'cliente'}`.slice(0, 120), modalidade: 'online', local: null, link: null,
        descricao: 'Marcada pelo agente na conversa.', criadoPor: null, origem: 'agente', agora: ctx.agora,
        transferirCarteira: false,
      })
      if (r.tipo === 'passado') return { situacao: 'oferta_vencida' as const }
      if (r.tipo === 'conflito') return { situacao: 'ocupado' as const }
      if (r.tipo === 'responsavel_invalido') return { situacao: 'responsavel_indisponivel' as const }
      if (r.tipo === 'sem_conversa') return { situacao: 'sem_conversa' as const }
      await tx`UPDATE reuniao_oferta SET confirmada_em = ${ctx.agora}, evento_id = ${r.eventoId}
                WHERE tenant_id = tenant_atual() AND id = ${o.id}`
      const [u] = await tx<{ nome: string }[]>`SELECT nome FROM usuario WHERE tenant_id = tenant_atual() AND id = ${opcao.usuarioId}`
      const l = local(opcao.inicio, exp.fuso)
      return {
        situacao: 'agendado' as const, eventoId: r.eventoId, usuarioId: opcao.usuarioId, quando: rotulo(l),
        com: primeiroNome(u?.nome ?? ''), contato: c?.nome ?? 'cliente', local: l,
      }
    })
  },
}
