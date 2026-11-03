import { z } from 'zod'
import { MAX_INDICACOES, ehDetratorNps, verificarNumerosNaResposta } from '@geracrm/shared'
import { comTenantServico } from '../../../../db/index.js'
import { registrarNpsDoAgente } from '../../../crm/nps-agente.js'
import { ErroIndicacoes, registrarIndicacoes } from '../../../crm/indicacao.js'
import { listarProvaSocialAprovada } from '../conhecimento/prova-social.js'
import { lerEstado } from '../estado-agente.js'
import { CHAVE_POS_VENDA, lerRoteiroPosVenda, marcarNpsRegistrado, npsAberto } from '../pos-venda.js'
import type { ContextoFerramenta, Ferramenta } from './porta.js'
import { numerosDe, percentuaisDe } from './porta.js'

/**
 * FERRAMENTAS DO PÓS-VENDA (raia G3; AM `registrar_nps`, `registrar_indicacoes`,
 * `consultar_prova_social`). Cada uma é ação habilitável do playbook
 * (`nps`, `indicacoes`, `provaSocial`) — desligada, sai do menu.
 *
 * ⚠️ Efeito REAL só no modo autônomo. Em sombra/assistido quem conduz é a pessoa
 *    (a decisão do agente é sugestão), e em simulação/copiloto nada é do cliente
 *    real: a ferramenta responde como se tivesse feito (`modoSeco: true`) e a
 *    chamada fica registrada na decisão — mesma regra do `memoria_anotar`.
 * ⚠️ Erro de negócio volta como `{ok:false, erro:'<codigo>: <frase>'}`: o laço
 *    continua e o modelo lê o motivo (nunca lança).
 */

const efeitoReal = (ctx: ContextoFerramenta): boolean => ctx.modo === 'autonomo'

export function ferramentaRegistrarNps(): Ferramenta<never> {
  const f: Ferramenta<{ nota: number; comentario: string | null }> = {
    nome: 'registrar_nps',
    descricao: 'Registra a nota de 0 a 10 que o cliente deu na pesquisa de satisfação do pós-venda (e o comentário dele, se houver). '
      + 'Só funciona quando a loja enviou a pesquisa nesta conversa. Use a nota exatamente como o cliente escreveu; nunca deduza.',
    entrada: z.object({
      nota: z.number().int().min(0).max(10),
      comentario: z.string().max(500).nullable(),
    }),
    async executar(ctx, e) {
      return comTenantServico(ctx.tenantId, async (tx) => {
        const r = lerRoteiroPosVenda((await lerEstado(tx, ctx.sessaoId))[CHAVE_POS_VENDA])
        // ⚠️ Sem pesquisa enviada (ou já respondida, ou vencida), não há nota a registrar.
        if (!ctx.sessaoId || !npsAberto(r, ctx.agora)) {
          return { ok: false as const, erro: 'nps.nao_perguntado: a loja não enviou a pesquisa de nota nesta conversa (ou ela já foi respondida). Não registre; siga a conversa.' }
        }
        const detrator = ehDetratorNps(e.nota)
        if (!efeitoReal(ctx)) return { ok: true as const, saida: { registrado: true, detrator, modoSeco: true } }
        // A marca na sessão vem ANTES do insert: duas chamadas no mesmo turno — só uma passa.
        if (!(await marcarNpsRegistrado(tx, ctx.sessaoId, r.em, ctx.agora))) {
          return { ok: false as const, erro: 'nps.ja_registrado: a nota desta pesquisa já foi registrada.' }
        }
        const reg = await registrarNpsDoAgente(tx, {
          contatoId: ctx.contatoId, conversaId: ctx.conversaId, nota: e.nota, comentario: e.comentario, agora: ctx.agora,
        })
        return {
          ok: true as const,
          saida: {
            registrado: true, detrator: reg.detrator,
            ...(reg.detrator ? { proximoPasso: 'Agradeça, peça desculpas pelo que não foi bom e diga que alguém da equipe vai falar com ele. Não prometa prazo nem compensação.' } : {}),
          },
        }
      })
    },
  }
  return f as Ferramenta<never>
}

export function ferramentaRegistrarIndicacoes(): Ferramenta<never> {
  const f: Ferramenta<{ indicacoes: { nome: string; telefone: string; observacao: string | null }[] }> = {
    nome: 'registrar_indicacoes',
    descricao: `Cadastra pessoas que o cliente indicou (nome e telefone, no máximo ${MAX_INDICACOES} por vez). `
      + 'Não duplica quem já está cadastrado — nesse caso só diz que já é cliente. Não peça outros dados pessoais.',
    entrada: z.object({
      indicacoes: z.array(z.object({
        nome: z.string().min(1).max(120),
        telefone: z.string().min(8).max(30),
        observacao: z.string().max(300).nullable(),
      })).min(1).max(MAX_INDICACOES),
    }),
    async executar(ctx, e) {
      if (!efeitoReal(ctx)) {
        return { ok: true, saida: { modoSeco: true, itens: e.indicacoes.map((i) => ({ nome: i.nome, situacao: 'criado' })) } }
      }
      try {
        const r = await comTenantServico(ctx.tenantId, (tx) => registrarIndicacoes(tx, { indicanteId: ctx.contatoId, indicacoes: e.indicacoes }))
        // ⚠️ Só nome (o que o próprio cliente disse) e situação: nada do contato existente.
        return { ok: true, saida: { itens: r.itens, cadastrados: r.criados } }
      } catch (err) {
        if (err instanceof ErroIndicacoes) {
          return { ok: false, erro: err.codigo === 'limite' ? `indicacoes.limite: no máximo ${MAX_INDICACOES} por vez.` : `indicacoes.${err.codigo}` }
        }
        throw err
      }
    },
  }
  return f as Ferramenta<never>
}

export function ferramentaConsultarProvaSocial(): Ferramenta<never> {
  const f: Ferramenta<{ tema: string | null }> = {
    nome: 'consultar_prova_social',
    descricao: 'Depoimentos de clientes e números da loja APROVADOS para citar (com fonte e data). Única origem permitida de prova social: '
      + 'use o texto como veio e cite a fonte. Lista vazia = não cite números nem depoimentos.',
    entrada: z.object({ tema: z.string().max(120).nullable() }),
    async executar(ctx, e) {
      const itens = await comTenantServico(ctx.tenantId, (tx) => listarProvaSocialAprovada(tx, {
        canalId: ctx.canalId, tema: e.tema?.trim() || null, agora: ctx.agora,
      }))
      const saida = itens.length > 0
        ? { itens: itens.map((i) => ({ tipo: i.tipo, texto: i.texto, fonte: i.fonte, link: i.link, apuradoEm: i.apuradoEm, documentoId: i.documentoId, versao: i.versao })) }
        : { itens: [], aviso: 'Nenhuma prova social aprovada: não cite números, avaliações nem depoimentos.' }
      // ⚠️ O TEXTO aprovado é fonte do guardrail numérico (P7) — só neste turno, só por aqui.
      //    Valor em reais no texto ("economizou R$ 500") vira centavos permitidos pela mesma regra.
      const textos = itens.map((i) => i.texto)
      const centavos = textos.flatMap((t) => verificarNumerosNaResposta(t, new Set()))
      return { ok: true, saida, centavos, numeros: numerosDe(textos), percentuais: percentuaisDe(textos) }
    },
  }
  return f as Ferramenta<never>
}
