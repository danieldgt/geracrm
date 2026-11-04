import { z } from 'zod'
import { OPCOES_POR_OFERTA, efeitoDaAgenda, linhaDaOpcao } from '@geracrm/shared'
import type { AgendaPorta } from './ligacoes-porta.js'
import type { Ferramenta, SaidaFerramenta } from './porta.js'
import { numerosDe } from './porta.js'
import { chaveDoTurno, reuniaoDoTurno } from './agenda-turno.js'

/**
 * `agendar_reuniao` (raia C3; AM "ofertar/confirmar horário") — PROPOR E CONFIRMAR, como o
 * `pedido_propor`: o modelo nunca marca sozinho.
 *
 *   ofertar   → até 3 horários livres (responsável do contato primeiro, depois a filial). O TEXTO
 *               das opções numeradas é montado AQUI (`texto`) e o modelo o envia como está — a
 *               etapa `reuniao` do pipeline confere (A1/A3). Uma oferta por turno. No autônomo a
 *               oferta é gravada, mas só vale depois que a mensagem chega ao gateway (pós-envio).
 *   confirmar → só cria o evento se o CLIENTE escolheu aquela opção na mensagem MAIS RECENTE dele,
 *               depois de uma oferta ENVIADA, ainda válida e não usada (`interpretarEscolhaDeHorario`).
 *
 * ⚠️ Só entra no menu com o módulo Agenda ligado, a chave do número ligada e o número em
 *    assistido/autônomo (`agendaNoTurno`, montado em `ligacoesPadrao`).
 * ⚠️ Efeito real só no modo efetivo autônomo (`efeitoDaAgenda`). Sombra, assistido, simulação e
 *    copiloto respondem em modo seco: nada é gravado e a saída diz isso.
 * ⚠️ O que a ferramenta devolveu fica no registro do turno (`agenda-turno.ts`): é a fonte da guarda.
 * ⚠️ Já existe reunião futura desta conversa → passa para uma pessoa (remarcar é humano, M7).
 */
export function ferramentaAgendarReuniao(agenda: AgendaPorta): Ferramenta<never> {
  const f: Ferramenta<{ acao: 'ofertar' | 'confirmar'; dia: string | null; opcao: number | null }> = {
    nome: 'agendar_reuniao',
    descricao: 'Marca uma reunião do cliente com um vendedor, em duas etapas. '
      + '"ofertar": busca horários livres (use quando o cliente aceitar conversar com um vendedor ou pedir reunião; '
      + '`dia` = AAAA-MM-DD se ele pediu um dia, senão null) e devolve `texto` com as opções numeradas — envie esse texto EXATAMENTE como veio '
      + 'e pergunte qual o cliente prefere. "confirmar": só DEPOIS que o cliente responder escolhendo uma opção, com `opcao` = o número que ELE escolheu. '
      + 'Nunca confirme no mesmo turno da oferta, nunca escolha pelo cliente, nunca cite horário ou dia que não veio daqui e nunca diga que a reunião '
      + 'está marcada sem `situacao: "agendado"`.',
    entrada: z.object({
      acao: z.enum(['ofertar', 'confirmar']),
      dia: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
      opcao: z.number().int().min(1).max(OPCOES_POR_OFERTA).nullable(),
    }),
    async executar(ctx, e): Promise<SaidaFerramenta> {
      const real = efeitoDaAgenda(ctx.modo) === 'real'
      const turno = reuniaoDoTurno(chaveDoTurno(ctx.tenantId, ctx.conversaId, ctx.agora))
      turno.usouFerramenta = true
      const jaTem = (quando: string): SaidaFerramenta => ({
        ok: true, efeito: 'handoff',
        handoff: { motivo: 'fora_do_escopo', resumo: `O cliente já tem reunião marcada nesta conversa (${quando}); remarcar ou marcar outra é com uma pessoa.` },
        saida: { situacao: 'ja_tem_reuniao', proximoPasso: 'Diga que uma pessoa da equipe vai cuidar disso e despeça-se em uma frase, sem citar horário.' },
      })

      if (e.acao === 'ofertar') {
        // ⚠️ A3: uma oferta por turno — a segunda trocaria o que o cliente leu.
        if (turno.linhasOfertadas.length > 0) return { ok: false, erro: 'reuniao.ja_ofertado: os horários deste turno já foram ofertados; envie o `texto` da primeira oferta.' }
        const r = await agenda.ofertar(ctx, { dia: e.dia, real })
        if (r.situacao === 'ja_tem_reuniao') return jaTem(r.quando)
        if (r.situacao !== 'ok') {
          const proximo = r.situacao === 'sem_vendedor'
            ? 'Não há vendedor para a reunião: transfira para a equipe (atendimento_transferir).'
            : r.situacao === 'dia_invalido' ? 'Dia fora do período que dá para marcar: peça outro dia.'
              : r.situacao === 'limite_ofertas' ? 'Já foram ofertados horários demais hoje: transfira para a equipe combinar.'
                : 'Sem horário livre: ofereça outro dia ou transfira para a equipe.'
          return { ok: true, saida: { situacao: r.situacao, proximoPasso: proximo } }
        }
        const linhas = r.opcoes.map(linhaDaOpcao)
        turno.linhasOfertadas = linhas
        turno.ofertaId = r.ofertaId
        turno.quandos.push(...r.opcoes.map((o) => ({ data: o.data, hora: o.hora, diaIso: o.diaIso })))
        const saida = {
          situacao: 'ok', texto: linhas.join('\n'),
          proximoPasso: 'Envie o `texto` exatamente como está (uma linha por opção) e pergunte qual o cliente prefere. Só confirme depois da resposta dele.',
          ...(real ? {} : { modoSeco: true }),
        }
        return { ok: true, saida, numeros: numerosDe(linhas) }
      }
      if (e.opcao === null) return { ok: false, erro: 'reuniao.opcao_obrigatoria: em "confirmar", informe o número da opção que o cliente escolheu.' }
      // ⚠️ Seco: nada é criado — a saída diz isso para a resposta não afirmar o que não houve.
      if (!real) {
        return {
          ok: true,
          saida: {
            situacao: 'modo_seco', modoSeco: true,
            aviso: 'Ensaio: a reunião NÃO foi criada. Diga que um vendedor vai confirmar o horário com o cliente, sem citar horário.',
          },
        }
      }
      const r = await agenda.confirmar(ctx, { opcao: e.opcao })
      if (r.situacao === 'ja_tem_reuniao') return jaTem(r.quando)
      if (r.situacao === 'agendado') {
        turno.agendado = { eventoId: r.eventoId, usuarioId: r.usuarioId, hora: r.local.hora, quando: r.quando, contato: r.contato }
        turno.quandos.push(r.local)
        return { ok: true, saida: { situacao: 'agendado', quando: r.quando, com: r.com }, numeros: numerosDe({ quando: r.quando }) }
      }
      const proximo: Record<string, string> = {
        sem_oferta: 'Ainda não há horários ofertados nesta conversa: chame "ofertar" primeiro.',
        mesmo_turno: 'O cliente ainda não viu os horários: envie as opções e espere a resposta.',
        oferta_nao_enviada: 'Os horários ofertados não chegaram ao cliente: chame "ofertar" de novo.',
        oferta_vencida: 'A oferta venceu: chame "ofertar" de novo.',
        ja_confirmada: 'Esta reunião já foi marcada; não marque de novo.',
        sem_confirmacao: 'O cliente não escolheu uma opção de forma clara: pergunte qual NÚMERO de opção ele prefere.',
        cliente_recusou: 'O cliente não quis nenhuma das opções: pergunte o melhor dia e chame "ofertar" de novo.',
        opcao_inexistente: 'Essa opção não existe na oferta: confira o número com o cliente.',
        confirmacao_divergente: 'A escolha do cliente não bate com essa opção: pergunte de novo qual NÚMERO ele prefere.',
        ocupado: 'Esse horário acabou de ser ocupado: peça desculpas e chame "ofertar" de novo.',
        responsavel_indisponivel: 'O vendedor dessa opção não está mais disponível: chame "ofertar" de novo.',
        sem_conversa: 'Não foi possível marcar nesta conversa: transfira para a equipe.',
      }
      // ⚠️ A2: nunca devolve ao modelo qual opção o cliente "teria" escolhido — ele pergunta de novo.
      return { ok: true, saida: { situacao: r.situacao, proximoPasso: proximo[r.situacao] } }
    },
  }
  return f as Ferramenta<never>
}
