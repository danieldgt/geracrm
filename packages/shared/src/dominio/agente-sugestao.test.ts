import { describe, expect, it } from 'vitest'
import {
  avisosDaSugestao, bloqueadaPelaQualidade, estadoDaSugestao, foiEditada, motivoDoBloqueio, naoEnvieAssim, pedeConfirmarOptOut, similaridadeTextos,
  taxaSombra, taxasDaSugestao, textoComparavel, textoDaSugestao, classificarUso, envioIgualAoBloqueado, LIMIAR_SIMILARIDADE_USO,
} from './agente-sugestao.js'
import * as indice from '../index.js'

describe('Uso da sugestão: enviada, editada ou superada (reescrita por cima)', () => {
  it('igual → enviada; edição pequena → editada; texto outro (< 0,2) → superada', () => {
    const s = 'Temos o sabão neutro em caixa com 12 unidades, entrega amanhã.'
    expect(classificarUso(s, ` ${s} `).estado).toBe('enviada')
    expect(classificarUso(s, 'Temos o sabão neutro em caixa com 24 unidades, entrega amanhã.').estado).toBe('editada')
    const outro = classificarUso(s, 'Bom dia! Vou ver com o gerente e te chamo.')
    expect(outro.similaridade).toBeLessThan(LIMIAR_SIMILARIDADE_USO)
    expect(outro.estado).toBe('superada')
  })
})

describe('Envio igual ao bloqueado (P12 nao_envie)', () => {
  it('idêntico ou mesmas palavras (só pontuação/ordem) conta como igual; reescrito não', () => {
    const s = 'Garantimos a entrega amanhã sem falta.'
    expect(envioIgualAoBloqueado(s, s)).toBe(true)
    expect(envioIgualAoBloqueado(s, 'garantimos a entrega amanhã, sem falta!')).toBe(true)
    expect(envioIgualAoBloqueado(s, 'A entrega está prevista para amanhã, confirmo com a transportadora.')).toBe(false)
  })
})

describe('Índice do pacote', () => {
  it('a marca nao_envie tem UMA fonte (P12): a P13 não reexporta constantes próprias', () => {
    expect(indice.ETAPA_REGRAS_QUALIDADE).toBe('regras-qualidade')
    expect(indice.CODIGO_NAO_ENVIE).toBe('nao_envie')
    expect('ETAPA_QUALIDADE' in indice).toBe(false)
    expect('SUGESTAO_CODIGO_NAO_ENVIE' in indice).toBe(false)
    expect(bloqueadaPelaQualidade([{ etapa: indice.ETAPA_REGRAS_QUALIDADE, codigo: indice.CODIGO_NAO_ENVIE, gravidade: 'CRITICA', acao: 'bloqueado' }])).toBe(true)
  })
})
import { enviarMensagemEntrada } from './mensagem.js'
import type { MarcaGuardrail } from './agente-vendedor.js'

const m = (codigo: string, gravidade: MarcaGuardrail['gravidade'], acao: MarcaGuardrail['acao'] = 'removido'): MarcaGuardrail =>
  ({ etapa: 'filtro-saida', codigo, gravidade, acao })

describe('Edição: enviada × editada', () => {
  it('dado o mesmo texto com espaços diferentes, então não é edição', () => {
    expect(foiEditada('Temos sim!  Quer  que eu separe?', ' Temos sim! Quer que eu separe? ')).toBe(false)
  })
  it('dado troca de pontuação ou caixa, então é edição', () => {
    expect(foiEditada('Ok.', 'ok')).toBe(true)
    expect(foiEditada('Temos sim', 'Temos sim!')).toBe(true)
  })
  it('textoComparavel normaliza NFC (é composto = é decomposto)', () => {
    expect(textoComparavel('é')).toBe(textoComparavel('é'))
  })
})

describe('Similaridade (Jaccard de palavras significativas)', () => {
  it('textos iguais → 1; sem nenhuma palavra em comum → 0', () => {
    expect(similaridadeTextos('Temos a caixa com 12 unidades', 'Temos a caixa com 12 unidades')).toBe(1)
    expect(similaridadeTextos('Bom dia, tudo certo?', 'Pedido faturado ontem')).toBe(0)
  })
  it('ordem, acento, caixa e pontuação não pesam', () => {
    expect(similaridadeTextos('Caixa com 12 unidades, entrega amanhã.', 'ENTREGA amanha: 12 unidades na caixa')).toBe(1)
  })
  it('número diferente conta como palavra diferente', () => {
    const s = similaridadeTextos('caixa com 12 unidades', 'caixa com 24 unidades')
    expect(s).toBeLessThan(1)
    expect(s).toBe(0.5) // {caixa, 12, unidades} × {caixa, 24, unidades} → 2/4
  })
  it('edição pequena fica alta, reescrita fica baixa', () => {
    const base = 'Temos o produto em estoque e o pedido sai amanhã pela transportadora'
    expect(similaridadeTextos(base, base + ', combinado?')).toBeGreaterThan(0.8)
    expect(similaridadeTextos(base, 'Vou verificar com a equipe e te retorno')).toBeLessThan(0.2)
  })
  it('textos sem palavra significativa: iguais → 1, diferentes → 0', () => {
    expect(similaridadeTextos('ok', 'Ok!')).toBe(1)
    expect(similaridadeTextos('ok', 'sim')).toBe(0)
    expect(similaridadeTextos('ok', 'Pedido faturado')).toBe(0)
  })
  it('é simétrica e fica em [0,1] com 3 casas', () => {
    const a = 'Posso separar 10 caixas do sabão neutro para você?'
    const b = 'Separo 10 caixas de sabão?'
    expect(similaridadeTextos(a, b)).toBe(similaridadeTextos(b, a))
    const s = similaridadeTextos(a, b)
    expect(s).toBeGreaterThanOrEqual(0)
    expect(s).toBeLessThanOrEqual(1)
    expect(Math.round(s * 1000) / 1000).toBe(s)
  })
})

describe('Avisos por gravidade', () => {
  it('ordena CRÍTICA → ALTA → MÉDIA, deduplica por código e esconde INFO', () => {
    const avisos = avisosDaSugestao([
      m('max_caracteres', 'MEDIA'), m('abertura', 'INFO', 'registrado'), m('pede_consentimento', 'ALTA'),
      m('oferece_desconto', 'CRITICA'), m('oferece_desconto', 'ALTA'),
    ])
    expect(avisos.map((a) => [a.codigo, a.gravidade])).toEqual([
      ['oferece_desconto', 'CRITICA'], ['pede_consentimento', 'ALTA'], ['max_caracteres', 'MEDIA'],
    ])
    expect(avisos[0]!.texto).toMatch(/desconto/)
  })
  it('código desconhecido ganha texto genérico nomeando a proteção', () => {
    expect(avisosDaSugestao([m('regra_nova_x', 'ALTA', 'reescrito')])[0]!.texto).toMatch(/reescrito.*regra nova x/)
  })
  it('CRÍTICA = não envie assim; opt-out a confirmar é detectado', () => {
    expect(naoEnvieAssim([m('valor_sem_fonte', 'CRITICA', 'substituido')])).toBe(true)
    expect(naoEnvieAssim([m('pede_consentimento', 'ALTA')])).toBe(false)
    expect(pedeConfirmarOptOut([m('opt_out_confirmar', 'ALTA', 'registrado')])).toBe(true)
  })
  it('opt-out a confirmar não se repete na lista de avisos (o cartão já o destaca)', () => {
    const avisos = avisosDaSugestao([m('opt_out_confirmar', 'ALTA', 'registrado'), m('possivel_opt_out', 'MEDIA', 'registrado')])
    expect(avisos.map((a) => a.codigo)).toEqual(['possivel_opt_out'])
  })
})

describe('Bloqueio da qualidade (P12 nao_envie)', () => {
  const nao: MarcaGuardrail = { etapa: 'regras-qualidade', codigo: 'nao_envie', gravidade: 'CRITICA', acao: 'bloqueado', trecho: 'promessa de prazo' }
  it('só a marca regras-qualidade/nao_envie bloqueia; outra CRÍTICA só avisa', () => {
    expect(bloqueadaPelaQualidade([nao])).toBe(true)
    expect(bloqueadaPelaQualidade([m('oferece_desconto', 'CRITICA')])).toBe(false)
    expect(bloqueadaPelaQualidade([{ ...nao, etapa: 'filtro-saida' }])).toBe(false)
  })
  it('o motivo é o trecho da marca; sem trecho, um texto padrão', () => {
    expect(motivoDoBloqueio([nao])).toBe('promessa de prazo')
    expect(motivoDoBloqueio([{ ...nao, trecho: undefined }])).toMatch(/Violação crítica/)
    expect(motivoDoBloqueio([m('oferece_desconto', 'CRITICA')])).toBeNull()
  })
  it('nao_envie também aparece como aviso CRÍTICO', () => {
    expect(avisosDaSugestao([nao])[0]).toMatchObject({ codigo: 'nao_envie', gravidade: 'CRITICA' })
  })
})

describe('Taxas e estados', () => {
  it('uso, sem edição e descarte a partir das contagens do banco', () => {
    const t = taxasDaSugestao({ geradas: 10, enviadas: 3, editadas: 1, descartadas: 2, superadas: 1, pendentes: 3, criticas: 0, similaridadeMediaEditadas: 0.7 })
    expect(t).toEqual({ taxaUso: 0.4, taxaSemEdicao: 0.75, taxaDescarte: 0.2 })
  })
  it('sem base → null, nunca divisão por zero', () => {
    expect(taxasDaSugestao({ geradas: 0, enviadas: 0, editadas: 0, descartadas: 0, superadas: 0, pendentes: 0, criticas: 0, similaridadeMediaEditadas: null }))
      .toEqual({ taxaUso: null, taxaSemEdicao: null, taxaDescarte: null })
    expect(taxaSombra({ comparados: 0, similaridadeMedia: null, acimaDoLimiar: 0 })).toBeNull()
    expect(taxaSombra({ comparados: 4, similaridadeMedia: 0.5, acimaDoLimiar: 3 })).toBe(0.75)
  })
  it('coluna NULL = pendente', () => {
    expect(estadoDaSugestao(null)).toBe('pendente')
    expect(estadoDaSugestao('editada')).toBe('editada')
    expect(estadoDaSugestao('qualquer')).toBe('pendente')
  })
  it('texto da sugestão junta as mensagens do turno', () => {
    expect(textoDaSugestao([' Oi! ', '', 'Quer ver o catálogo?'])).toBe('Oi!\n\nQuer ver o catálogo?')
  })
})

describe('Entrada de envio', () => {
  it('aceita sugestaoDecisaoId uuid opcional; malformado é DESCARTADO sem recusar a mensagem', () => {
    expect(enviarMensagemEntrada.safeParse({ tipo: 'texto', texto: 'oi' }).success).toBe(true)
    const ok = enviarMensagemEntrada.parse({ tipo: 'texto', texto: 'oi', sugestaoDecisaoId: '0190a3b0-0000-7000-8000-000000000001' })
    expect(ok).toMatchObject({ sugestaoDecisaoId: '0190a3b0-0000-7000-8000-000000000001' })
    const lixo = enviarMensagemEntrada.safeParse({ tipo: 'texto', texto: 'oi', sugestaoDecisaoId: 'x' })
    expect(lixo.success).toBe(true)
    expect(lixo.data).toEqual({ tipo: 'texto', texto: 'oi', sugestaoDecisaoId: undefined })
  })
})
