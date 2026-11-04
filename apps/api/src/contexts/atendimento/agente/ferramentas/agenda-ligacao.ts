import { randomUUID } from 'node:crypto'
import {
  DIAS_MAX_REUNIAO, DURACAO_REUNIAO_PADRAO, OPCOES_POR_OFERTA, VALIDADE_OFERTA_HORAS, interpretarEscolhaDeHorario,
  type EscolhaDeHorario, type HorarioLivre, type OpcaoOfertada,
} from '@geracrm/shared'
import { comTenantServico } from '../../../../db/index.js'
import { partesLocais } from '../../expediente.js'
import {
  agendarReuniao, diaLocal, horariosLivresDoDia, lerExpedienteReuniao, vendedoresParaReuniao,
} from '../../../crm/reuniao.js'
import type { AgendaPorta, OpcaoParaLlm } from './ligacoes-porta.js'

/**
 * A AGENDA REAL do agente (C3) — sobre o caso de uso público `crm/reuniao.ts`, o mesmo do
 * botão do inbox. Roda como serviço (`comTenantServico`): o agente é máquina, sem escopo.
 */

/** Sem dia pedido, procura nos próximos dias (hoje incluso) até achar opções. */
const DIAS_DE_BUSCA = 7
/** Quantas pessoas da filial tentar antes de desistir (o responsável é a primeira). */
const VENDEDORES_TENTADOS = 5
/** Entre duas opções do mesmo dia, pelo menos isto — o cliente escolhe entre horas diferentes. */
const INTERVALO_ENTRE_OPCOES_MIN = 120
const POR_DIA = 2
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

function rotulo(o: Pick<OpcaoOfertada, 'data' | 'hora'>, diaIso: number): string {
  return `${DIAS_SEMANA[diaIso] ?? ''}, ${o.data.slice(8, 10)}/${o.data.slice(5, 7)} às ${o.hora}`
}

export const agendaReal: AgendaPorta = {
  async ofertar(ctx, p) {
    return comTenantServico(ctx.tenantId, async (tx) => {
      const exp = await lerExpedienteReuniao(tx, ctx.canalId)
      const hoje = diaLocal(ctx.agora, exp.fuso)
      let dias: string[]
      if (p.dia) {
        const delta = (Date.parse(p.dia) - Date.parse(hoje)) / 86_400_000
        if (Number.isNaN(delta) || delta < 0 || delta > DIAS_MAX_REUNIAO) return { situacao: 'dia_invalido' as const }
        dias = [p.dia]
      } else {
        dias = Array.from({ length: DIAS_DE_BUSCA }, (_, i) => somarDias(hoje, i))
      }
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
          const local = partesLocais(new Date(h.inicio), exp.fuso)
          return { n: i + 1, usuarioId: v.usuarioId, inicio: h.inicio, fim: h.fim, hora: local.hora, data: local.data }
        })
        const opcoes: OpcaoParaLlm[] = ofertadas.map((o) => ({
          n: o.n, quando: rotulo(o, partesLocais(new Date(o.inicio), exp.fuso).diaIso), com: primeiroNome(v.nome),
        }))
        // ⚠️ Só a oferta que CHEGA ao cliente (autônomo) é gravada: é ela que o "sim" confirma.
        if (p.real) {
          await tx`
            INSERT INTO reuniao_oferta (tenant_id, id, conversa_id, contato_id, canal_id, opcoes, ofertada_em, expira_em)
            VALUES (tenant_atual(), ${randomUUID()}, ${ctx.conversaId}, ${ctx.contatoId}, ${ctx.canalId},
                    ${JSON.stringify(ofertadas)}::text::jsonb, ${ctx.agora},
                    ${new Date(ctx.agora.getTime() + VALIDADE_OFERTA_HORAS * 3_600_000)})`
        }
        return { situacao: 'ok' as const, opcoes }
      }
      return { situacao: 'sem_horarios' as const }
    })
  },

  async confirmar(ctx, p) {
    return comTenantServico(ctx.tenantId, async (tx) => {
      const [o] = await tx<{ id: string; opcoes: OpcaoOfertada[]; ofertada_em: Date; expira_em: Date; confirmada_em: Date | null }[]>`
        SELECT id, opcoes, ofertada_em, expira_em, confirmada_em FROM reuniao_oferta
         WHERE tenant_id = tenant_atual() AND conversa_id = ${ctx.conversaId}
         ORDER BY ofertada_em DESC LIMIT 1 FOR UPDATE`
      if (!o) return { situacao: 'sem_oferta' as const }
      if (o.confirmada_em) return { situacao: 'ja_confirmada' as const }
      // ⚠️ Oferta deste mesmo turno: o cliente ainda não leu — não há "sim" possível.
      if (o.ofertada_em.getTime() >= ctx.agora.getTime()) return { situacao: 'mesmo_turno' as const }
      if (o.expira_em.getTime() <= ctx.agora.getTime()) return { situacao: 'oferta_vencida' as const }
      const opcao = o.opcoes.find((x) => x.n === p.opcao)
      if (!opcao) return { situacao: 'opcao_inexistente' as const }

      // ⚠️ A confirmação EXPLÍCITA do cliente é conferida AQUI, em código, nas mensagens dele
      //    que chegaram depois da oferta — a mais recente que disser algo claro decide.
      const msgs = await tx<{ texto: string | null }[]>`
        SELECT conteudo->>'texto' AS texto FROM mensagem
         WHERE tenant_id = tenant_atual() AND conversa_id = ${ctx.conversaId} AND direcao = 'entrante'
           AND criado_em > ${o.ofertada_em}
         ORDER BY criado_em DESC LIMIT 5`
      let escolha: EscolhaDeHorario = { tipo: 'indefinido' }
      for (const m of msgs) {
        const e = interpretarEscolhaDeHorario(m.texto ?? '', o.opcoes)
        if (e.tipo !== 'indefinido') { escolha = e; break }
      }
      if (escolha.tipo === 'recusou') return { situacao: 'cliente_recusou' as const }
      if (escolha.tipo === 'indefinido') return { situacao: 'sem_confirmacao' as const }
      if (escolha.n !== p.opcao) return { situacao: 'confirmacao_divergente' as const, escolhida: escolha.n }

      const [c] = await tx<{ nome: string }[]>`SELECT nome FROM contato WHERE tenant_id = tenant_atual() AND id = ${ctx.contatoId}`
      const r = await agendarReuniao(tx, {
        conversaId: ctx.conversaId, usuarioId: opcao.usuarioId, inicio: new Date(opcao.inicio), fim: new Date(opcao.fim),
        titulo: `Reunião com ${c?.nome ?? 'cliente'}`.slice(0, 120), modalidade: 'online', local: null, link: null,
        descricao: 'Marcada pelo agente na conversa.', criadoPor: null, origem: 'agente', agora: ctx.agora,
      })
      if (r.tipo === 'passado') return { situacao: 'oferta_vencida' as const }
      if (r.tipo !== 'ok') return { situacao: 'ocupado' as const }
      await tx`UPDATE reuniao_oferta SET confirmada_em = ${ctx.agora}, evento_id = ${r.eventoId}
                WHERE tenant_id = tenant_atual() AND id = ${o.id}`
      const [u] = await tx<{ nome: string }[]>`SELECT nome FROM usuario WHERE tenant_id = tenant_atual() AND id = ${opcao.usuarioId}`
      const diaIso = partesLocais(new Date(opcao.inicio), (await lerExpedienteReuniao(tx, null)).fuso).diaIso
      return { situacao: 'agendado' as const, quando: rotulo(opcao, diaIso), com: primeiroNome(u?.nome ?? ''), responsavelAlterado: r.responsavelAlterado }
    })
  },
}
