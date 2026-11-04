import { z } from 'zod'
import { OPCOES_POR_OFERTA, efeitoDaAgenda } from '@geracrm/shared'
import type { AgendaPorta } from './ligacoes-porta.js'
import type { Ferramenta } from './porta.js'
import { numerosDe } from './porta.js'

/**
 * `agendar_reuniao` (raia C3; AM "ofertar/confirmar horário") — PROPOR E CONFIRMAR, como o
 * `pedido_propor`: o modelo nunca marca sozinho.
 *
 *   ofertar   → até 3 horários livres (responsável do contato primeiro, depois a filial),
 *               numerados; no autônomo a oferta fica gravada (`reuniao_oferta`).
 *   confirmar → só cria o evento se o CLIENTE escolheu aquela opção numa mensagem que chegou
 *               DEPOIS da oferta (turno anterior), ainda válida e não usada. Quem confere é o
 *               código (`interpretarEscolhaDeHorario`), não o modelo.
 *
 * ⚠️ Só entra no menu com o módulo Agenda ligado, a chave do número ligada e o número em
 *    assistido/autônomo (`agendaNoTurno`, montado em `ligacoesPadrao`).
 * ⚠️ Efeito real só no modo efetivo autônomo (`efeitoDaAgenda`). Sombra, assistido,
 *    simulação e copiloto respondem em modo seco: nada é gravado e a saída diz isso.
 * ⚠️ Datas e horas que o modelo pode repetir vêm daqui (`numeros`): é a fonte do guardrail.
 */
export function ferramentaAgendarReuniao(agenda: AgendaPorta): Ferramenta<never> {
  const f: Ferramenta<{ acao: 'ofertar' | 'confirmar'; dia: string | null; opcao: number | null }> = {
    nome: 'agendar_reuniao',
    descricao: 'Marca uma reunião do cliente com um vendedor, em duas etapas. '
      + '"ofertar": busca horários livres (use quando o cliente aceitar conversar com um vendedor ou pedir reunião; '
      + '`dia` = AAAA-MM-DD se ele pediu um dia, senão null) e devolve opções numeradas — apresente-as e pergunte qual prefere. '
      + '"confirmar": só DEPOIS que o cliente responder escolhendo uma opção, com `opcao` = o número que ELE escolheu. '
      + 'Nunca confirme no mesmo turno da oferta nem escolha pelo cliente. Não invente horários: use só os devolvidos aqui.',
    entrada: z.object({
      acao: z.enum(['ofertar', 'confirmar']),
      dia: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
      opcao: z.number().int().min(1).max(OPCOES_POR_OFERTA).nullable(),
    }),
    async executar(ctx, e) {
      const real = efeitoDaAgenda(ctx.modo) === 'real'
      if (e.acao === 'ofertar') {
        const r = await agenda.ofertar(ctx, { dia: e.dia, real })
        if (r.situacao !== 'ok') {
          const proximo = r.situacao === 'sem_vendedor'
            ? 'Não há vendedor para a reunião: transfira para a equipe (atendimento_transferir).'
            : r.situacao === 'dia_invalido' ? 'Dia fora do período que dá para marcar: peça outro dia.'
              : 'Sem horário livre: ofereça outro dia ou transfira para a equipe.'
          return { ok: true, saida: { situacao: r.situacao, proximoPasso: proximo } }
        }
        const saida = {
          situacao: 'ok', opcoes: r.opcoes,
          proximoPasso: 'Apresente as opções numeradas e pergunte qual o cliente prefere. Só confirme depois da resposta dele.',
          ...(real ? {} : { modoSeco: true }),
        }
        return { ok: true, saida, numeros: numerosDe(r.opcoes) }
      }
      if (e.opcao === null) return { ok: false, erro: 'reuniao.opcao_obrigatoria: em "confirmar", informe o número da opção que o cliente escolheu.' }
      // ⚠️ Seco: nada é criado — a saída diz isso para a resposta não afirmar o que não houve.
      if (!real) {
        return {
          ok: true,
          saida: {
            situacao: 'modo_seco', modoSeco: true,
            aviso: 'Ensaio: a reunião NÃO foi criada. Diga que um vendedor vai confirmar o horário com o cliente.',
          },
        }
      }
      const r = await agenda.confirmar(ctx, { opcao: e.opcao })
      if (r.situacao === 'agendado') {
        return { ok: true, saida: { situacao: 'agendado', quando: r.quando, com: r.com }, numeros: numerosDe({ quando: r.quando }) }
      }
      const proximo: Record<string, string> = {
        sem_oferta: 'Ainda não há horários ofertados nesta conversa: chame "ofertar" primeiro.',
        mesmo_turno: 'O cliente ainda não viu os horários: apresente as opções e espere a resposta.',
        oferta_vencida: 'A oferta venceu: chame "ofertar" de novo.',
        ja_confirmada: 'Esta reunião já foi marcada; não marque de novo.',
        sem_confirmacao: 'O cliente não escolheu uma opção de forma clara: pergunte qual número ou horário ele prefere.',
        cliente_recusou: 'O cliente não quis nenhuma das opções: pergunte o melhor dia e chame "ofertar" de novo.',
        opcao_inexistente: 'Essa opção não existe na oferta: confira o número com o cliente.',
        ocupado: 'Esse horário acabou de ser ocupado: peça desculpas e chame "ofertar" de novo.',
        confirmacao_divergente: 'O cliente escolheu outra opção: confirme com ele qual prefere.',
      }
      return {
        ok: true,
        saida: {
          situacao: r.situacao, proximoPasso: proximo[r.situacao],
          ...(r.situacao === 'confirmacao_divergente' ? { escolhidaPeloCliente: r.escolhida } : {}),
        },
        ...(r.situacao === 'confirmacao_divergente' ? { numeros: [r.escolhida] } : {}),
      }
    },
  }
  return f as Ferramenta<never>
}
