import { describe, it, expect } from 'vitest'
import {
  FORM_VAZIO, PUBLICO_VAZIO, acoesDaTela, avisoDePausa, confirmacaoDaAcao, degrausDoFunil, errosDoPasso, excluidosOrdenados,
  formatarCusto, mapearErro, marcoDoDestinatario, montarCorpo, montarCorpoPrevia, montarPublico, passosComErro, podeAvancar,
  podeIniciar, resumoJanela, rotuloMotivoPausa, textoCustoPorVenda, textoTaxa, textoVariaveisFaltando, tomDoEstado,
  validarTelefonesTeste, formDaCampanha, isoParaLocal, resumoPublico, templateServeParaCampanha, variaveisDoCorpo, variaveisSemMapeamento, casaComTermo, type DestinatarioApi, type FormCampanha,
  avisoDeBloqueio, AVISO_PAUSA_DE_RISCO, avisoJanelaAjustada, ehPausaDeRisco, erroDoTeste, mensagemDeAcao,
} from './campanhas.regras.js'

const oficial: FormCampanha = { ...FORM_VAZIO, nome: ' Reativação ', canalId: 'c1', canalTipo: 'whatsapp_oficial', templateId: 't1' }
const naoOficial: FormCampanha = {
  ...FORM_VAZIO, nome: 'Promo', canalId: 'c2', canalTipo: 'whatsapp_nao_oficial', mensagem: ' Oi! ', confirmaRiscoBanimento: true,
}

describe('avisoDePausa — campanha segurada por suspensão das ativas (P11)', () => {
  it('sem suspensão, sem aviso', () => {
    expect(avisoDePausa(null)).toBeNull()
    expect(avisoDePausa(undefined)).toBeNull()
  })

  it('queda de qualidade: "pausada por qualidade do número", retoma sozinha', () => {
    const a = avisoDePausa({ desde: '2026-10-01T10:00:00Z', motivo: 'qualidade:FLAGGED:RED' })
    expect(a?.titulo).toBe('Pausada por qualidade do número')
    expect(a?.detalhe).toMatch(/retoma sozinha/)
  })

  it('motivo ausente vale como qualidade', () => {
    expect(avisoDePausa({ desde: '2026-10-01T10:00:00Z', motivo: null })?.titulo).toBe('Pausada por qualidade do número')
  })

  it('conta restrita: nomeia a conta e diz quem libera', () => {
    const a = avisoDePausa({ desde: '2026-10-01T10:00:00Z', motivo: 'conta:ACCOUNT_RESTRICTION' })
    expect(a?.titulo).toMatch(/conta do número/)
    expect(a?.detalhe).toMatch(/libere/)
  })
})

describe('errosDoPasso — passos válidos do wizard', () => {
  it('detalhes: nome e número são obrigatórios', () => {
    const e = errosDoPasso('detalhes', FORM_VAZIO)
    expect(e['nome']).toBeTruthy()
    expect(e['canalId']).toBeTruthy()
  })

  it('oficial exige template aprovado; texto livre não conta', () => {
    expect(errosDoPasso('detalhes', { ...oficial, templateId: '' })['templateId']).toMatch(/template/)
    expect(errosDoPasso('detalhes', { ...oficial, mensagem: 'texto' })).toEqual({})
    expect(podeAvancar('detalhes', oficial)).toBe(true)
  })

  it('não oficial exige texto E a confirmação do risco de banimento (ADR-021)', () => {
    expect(errosDoPasso('detalhes', { ...naoOficial, mensagem: '  ' })['mensagem']).toBeTruthy()
    expect(errosDoPasso('detalhes', { ...naoOficial, confirmaRiscoBanimento: false })['confirmaRiscoBanimento']).toMatch(/banimento/)
    expect(errosDoPasso('detalhes', naoOficial)).toEqual({})
  })

  it('canal que não é WhatsApp não faz campanha', () => {
    expect(errosDoPasso('detalhes', { ...oficial, canalTipo: 'instagram' })['canalId']).toMatch(/WhatsApp/)
  })

  it('público: números fora da faixa e período invertido apontam o campo', () => {
    const p = { ...PUBLICO_VAZIO, semInteracaoDias: '0', conversaRecenteDias: '91', criadoDe: '2026-02-10', criadoAte: '2026-02-01' }
    const e = errosDoPasso('publico', { ...oficial, publico: p })
    expect(e['publico.semInteracaoDias']).toBeTruthy()
    expect(e['publico.exclusoes.conversaRecenteDias']).toBeTruthy()
    expect(e['publico.criadoAte']).toBeTruthy()
    expect(errosDoPasso('publico', oficial)).toEqual({})
  })

  it('exclusão 0 desliga e é válida', () => {
    expect(errosDoPasso('publico', { ...oficial, publico: { ...PUBLICO_VAZIO, compraRecenteDias: '0' } })).toEqual({})
  })

  it('envio: lote, janela própria e janela de ROI', () => {
    expect(errosDoPasso('envio', { ...oficial, loteDiario: '0' })['loteDiario']).toBeTruthy()
    expect(errosDoPasso('envio', { ...oficial, loteDiario: '10001' })['loteDiario']).toBeTruthy()
    expect(errosDoPasso('envio', { ...oficial, loteDiario: '500' })).toEqual({})
    expect(errosDoPasso('envio', { ...oficial, janelaPropria: true, janela: { seg: null } })['janela']).toMatch(/pelo menos um dia/)
    expect(errosDoPasso('envio', { ...oficial, janelaPropria: true, janela: { seg: { de: '20:00', ate: '08:00' } } })['janela']).toMatch(/depois/)
    expect(errosDoPasso('envio', { ...oficial, janelaDias: '91' })['janelaDias']).toBeTruthy()
  })

  it('passosComErro lista só os passos pendentes', () => {
    expect(passosComErro(FORM_VAZIO)).toEqual(['detalhes'])
    expect(passosComErro(oficial)).toEqual([])
  })
})

describe('montarCorpo — o que vai para a API', () => {
  it('oficial: só templateId, nome aparado, sem texto nem confirmação, sem preço', () => {
    const c = montarCorpo(oficial)
    expect(c).toEqual({ nome: 'Reativação', canalId: 'c1', templateId: 't1', publico: {}, janelaDias: 7 })
    expect(Object.keys(c)).not.toContain('mensagem')
    expect(JSON.stringify(c)).not.toMatch(/preco|custo/i)
  })

  it('não oficial: mensagem + confirmaRiscoBanimento, sem template', () => {
    const c = montarCorpo(naoOficial)
    expect(c.mensagem).toBe('Oi!')
    expect(c.confirmaRiscoBanimento).toBe(true)
    expect(c.templateId).toBeUndefined()
  })

  it('lote, início agendado (ISO) e janela própria com os sete dias explícitos', () => {
    const c = montarCorpo({ ...oficial, loteDiario: '300', inicioEm: '2026-11-10T09:00', janelaPropria: true, janela: { seg: { de: '09:00', ate: '12:00' } } })
    expect(c.loteDiario).toBe(300)
    expect(c.inicioEm).toBe(new Date('2026-11-10T09:00').toISOString())
    expect(c.janela).toEqual({ seg: { de: '09:00', ate: '12:00' }, ter: null, qua: null, qui: null, sex: null, sab: null, dom: null })
  })

  it('sem janela própria, a janela não viaja (vale a do número)', () => {
    expect(montarCorpo(oficial).janela).toBeUndefined()
  })

  it('público: só tipos preenchidos, ids em vez de rótulos, exclusões numéricas', () => {
    const p = montarPublico({
      ...PUBLICO_VAZIO, segmentos: ['em-risco'], etiquetas: [{ valor: 'e1', rotulo: 'VIP' }], semInteracaoDias: '30',
      criadoDe: '2026-01-01', conversaRecenteDias: '0',
    })
    expect(p).toEqual({ segmentos: ['em-risco'], etiquetas: ['e1'], semInteracaoDias: 30, criadoDe: '2026-01-01', exclusoes: { conversaRecenteDias: 0 } })
  })

  it('prévia: sem número não há prévia; template só no oficial; lote inválido não viaja', () => {
    expect(montarCorpoPrevia(FORM_VAZIO)).toBeNull()
    expect(montarCorpoPrevia(oficial)).toEqual({ canalId: 'c1', templateId: 't1', publico: {} })
    expect(montarCorpoPrevia({ ...naoOficial, loteDiario: '99999' })).toEqual({ canalId: 'c2', publico: {} })
    expect(montarCorpoPrevia({ ...oficial, loteDiario: '200' })?.loteDiario).toBe(200)
  })
})

describe('formatação de custo e prévia', () => {
  it('centavos inteiros viram reais pt-BR', () => {
    expect(formatarCusto(0).replace(/\s/g, ' ')).toBe('R$ 0,00')
    expect(formatarCusto(12345).replace(/\s/g, ' ')).toBe('R$ 123,45')
    expect(formatarCusto(7).replace(/\s/g, ' ')).toBe('R$ 0,07')
  })

  it('custo por venda sem venda é traço, nunca R$ 0,00', () => {
    expect(textoCustoPorVenda(null)).toBe('—')
    expect(textoCustoPorVenda(250).replace(/\s/g, ' ')).toBe('R$ 2,50')
  })

  it('excluídos: só quem tem gente, na ordem dada; motivo novo vai para o fim', () => {
    const r = excluidosOrdenados({ optout: 3, compraRecente: 0, conversaRecente: 5, novoMotivo: 1 }, ['optout', 'conversaRecente', 'compraRecente'])
    expect(r.map((x) => x.motivo)).toEqual(['optout', 'conversaRecente', 'novoMotivo'])
  })

  it('taxa em décimos de ponto, sem base vira traço', () => {
    expect(textoTaxa(3, 100)).toBe('3,0%')
    expect(textoTaxa(1, 3)).toBe('33,3%')
    expect(textoTaxa(0, 0)).toBe('—')
  })

  it('resumo da janela agrupa dias com a mesma faixa', () => {
    expect(resumoJanela({ seg: { de: '08:00', ate: '20:00' }, ter: { de: '08:00', ate: '20:00' }, sab: { de: '09:00', ate: '12:00' }, dom: null }))
      .toBe('Seg, Ter 08:00–20:00; Sáb 09:00–12:00')
    expect(resumoJanela({ seg: null })).toBe('Nenhum dia aberto')
  })
})

describe('mapearErro — 422 por campo', () => {
  it('cada mensagem vai ao seu campo e o wizard volta ao primeiro passo com erro', () => {
    const r = mapearErro({ erro: 'campanha.invalida', mensagem: 'Confira.', campos: { loteDiario: 'Muito alto', nome: 'Obrigatório' } }, 'padrão')
    expect(r.campos).toEqual({ loteDiario: 'Muito alto', nome: 'Obrigatório' })
    expect(r.passo).toBe('detalhes')
    expect(r.geral).toBeNull()
  })

  it('público inválido leva ao passo Público', () => {
    const r = mapearErro({ campos: { 'publico.criadoDe': 'Inválido.' } }, 'x')
    expect(r.passo).toBe('publico')
  })

  it('janela aninhada sobe para o campo janela (passo Envio)', () => {
    const r = mapearErro({ campos: { 'janela.seg.de': 'hora inválida' } }, 'x')
    expect(r.campos).toEqual({ janela: 'hora inválida' })
    expect(r.passo).toBe('envio')
  })

  it('sem campos, a mensagem da API vai no topo; sem corpo, o padrão', () => {
    expect(mapearErro({ mensagem: 'Nenhum contato elegível.' }, 'x').geral).toBe('Nenhum contato elegível.')
    expect(mapearErro(null, 'Falhou.').geral).toBe('Falhou.')
  })

  it('template sem mapeamento carrega as variáveis faltando', () => {
    const r = mapearErro({ erro: 'campanha.template_sem_mapeamento', campos: { templateId: 'Variáveis sem mapeamento.' }, faltando: [1, 3] }, 'x')
    expect(r.faltando).toEqual([1, 3])
    expect(textoVariaveisFaltando(r.faltando)).toContain('{{1}}, {{3}}')
    expect(textoVariaveisFaltando([2])).toMatch(/^A variável \{\{2\}\} não tem/)
    expect(textoVariaveisFaltando([])).toBe('')
  })
})

describe('ações por estado', () => {
  const todas = { editar: false, excluir: false, iniciar: false, pausar: false, retomar: false, cancelar: false, testar: false }

  it('segue o `acoes` da API, na ordem de leitura', () => {
    const r = acoesDaTela(2, { ...todas, editar: true, excluir: true, iniciar: true, cancelar: true, testar: true })
    expect(r.map((a) => a.acao)).toEqual(['iniciar', 'testar', 'editar', 'cancelar', 'excluir'])
    expect(r.find((a) => a.acao === 'excluir')?.perigo).toBe(true)
    expect(r.find((a) => a.acao === 'iniciar')?.perigo).toBe(false)
  })

  it('pausada oferece retomar; enviando oferece pausar', () => {
    expect(acoesDaTela(2, { ...todas, retomar: true, cancelar: true }).map((a) => a.acao)).toEqual(['retomar', 'cancelar'])
    expect(acoesDaTela(2, { ...todas, pausar: true }).map((a) => a.acao)).toEqual(['pausar'])
  })

  it('campanha legada é só leitura, mesmo que a API mande ação', () => {
    expect(acoesDaTela(1, { ...todas, iniciar: true })).toEqual([])
    expect(acoesDaTela(2, null)).toEqual([])
  })

  it('confirmações nomeiam a campanha e dizem o que acontece', () => {
    expect(confirmacaoDaAcao('cancelar', 'Promo').mensagem).toContain('"Promo"')
    expect(confirmacaoDaAcao('pausar', 'Promo').acao).toBe('Pausar')
  })

  it('iniciar exige o nome exato (espaços nas pontas não contam, caixa conta)', () => {
    expect(podeIniciar('Promo Verão', ' Promo Verão ')).toBe(true)
    expect(podeIniciar('Promo Verão', 'promo verão')).toBe(false)
    expect(podeIniciar('Promo Verão', '')).toBe(false)
  })

  it('selo do estado: pausada chama atenção, cancelada é erro', () => {
    expect(tomDoEstado('pausada')).toBe('atencao')
    expect(tomDoEstado('cancelada')).toBe('erro')
    expect(tomDoEstado('concluida')).toBe('sucesso')
  })

  it('motivo da pausa por extenso; desconhecido cai no código', () => {
    expect(rotuloMotivoPausa('optout_alto')).toMatch(/2%/)
    expect(rotuloMotivoPausa('falhas_altas')).toMatch(/10%/)
    expect(rotuloMotivoPausa('algo_novo')).toBe('algo_novo')
    expect(rotuloMotivoPausa(null)).toBeNull()
  })
})

describe('telefones do teste', () => {
  it('guarda só dígitos, de 1 a 5, sem repetidos', () => {
    expect(validarTelefonesTeste(['(11) 91234-5678', '', ' '])).toEqual({ telefones: ['11912345678'], erro: null })
    expect(validarTelefonesTeste(['', '']).erro).toMatch(/pelo menos um/)
    expect(validarTelefonesTeste(['1191234-5678', '11 91234 5678']).erro).toMatch(/repetido/)
    expect(validarTelefonesTeste(['123']).erro).toMatch(/DDD/)
    expect(validarTelefonesTeste(['11911111111', '11922222222', '11933333333', '11944444444', '11955555555', '11966666666']).erro).toMatch(/No máximo 5/)
  })
})

describe('funil do detalhe', () => {
  it('degraus com taxa sobre o anterior e barra proporcional às enviadas', () => {
    const d = degrausDoFunil({ elegiveis: 1000, enviadas: 800, entregues: 760, lidas: 400, responderam: 80, pedidos: 8, vendasEstimadas: 20 })
    expect(d.map((x) => x.chave)).toEqual(['enviadas', 'entregues', 'lidas', 'respostas', 'pedidos'])
    expect(d[0]?.taxaDoAnterior).toBeNull()
    expect(d[1]?.taxaDoAnterior).toBe(95)
    expect(d[4]?.taxaDoAnterior).toBe(10)
    expect(d[2]?.larguraPct).toBe(50)
  })

  it('sem envios: tudo zero, sem divisão por zero; degrau com valor nunca some', () => {
    const z = degrausDoFunil({ elegiveis: 0, enviadas: 0, entregues: 0, lidas: 0, responderam: 0, pedidos: 0, vendasEstimadas: 0 })
    expect(z.every((x) => x.larguraPct === 0 && (x.taxaDoAnterior === null))).toBe(true)
    const p = degrausDoFunil({ elegiveis: 10000, enviadas: 10000, entregues: 10000, lidas: 10, responderam: 1, pedidos: 1, vendasEstimadas: 0 })
    expect(p[4]?.larguraPct).toBe(2)
  })
})

describe('formDaCampanha — edição do rascunho', () => {
  it('devolve o formulário com rótulos resolvidos e o início em horário local', () => {
    const f = formDaCampanha({
      nome: 'Promo', canal: { id: 'c1', tipo: 'whatsapp_oficial' }, template: { id: 't1' }, mensagem: null,
      publico: { segmentos: ['em-risco'], etiquetas: ['e1', 'e2'], semInteracaoDias: 30, exclusoes: { compraRecenteDias: 0 } },
      loteDiario: 300, inicioEm: '2026-11-10T12:00:00.000Z', janela: { seg: { de: '09:00', ate: '12:00' } }, janelaDias: 14,
      confirmaRiscoBanimento: false,
    }, (tipo, id) => (tipo === 'etiquetas' && id === 'e1' ? 'VIP' : null))
    expect(f.publico.etiquetas).toEqual([{ valor: 'e1', rotulo: 'VIP' }, { valor: 'e2', rotulo: 'Item e2' }])
    expect(f.publico.semInteracaoDias).toBe('30')
    expect(f.publico.compraRecenteDias).toBe('0')
    expect(f.loteDiario).toBe('300')
    expect(f.janelaPropria).toBe(true)
    expect(f.janela['ter']).toBeNull()
    expect(f.janelaDias).toBe('14')
    expect(f.inicioEm).toBe(isoParaLocal('2026-11-10T12:00:00.000Z'))
    expect(f.inicioEm).toMatch(/^2026-11-10T\d\d:00$/)
  })

  it('o que a tela monta de volta é o que foi gravado (ida e volta)', () => {
    const corpo = montarCorpo({ ...oficial, loteDiario: '250', publico: { ...PUBLICO_VAZIO, segmentos: ['nao-perder'], semInteracaoDias: '10' } })
    const f = formDaCampanha({
      nome: corpo.nome, canal: { id: 'c1', tipo: 'whatsapp_oficial' }, template: { id: 't1' }, mensagem: null, publico: corpo.publico,
      loteDiario: corpo.loteDiario ?? null, inicioEm: null, janela: null, janelaDias: corpo.janelaDias, confirmaRiscoBanimento: false,
    }, () => null)
    expect(montarCorpo(f)).toEqual(corpo)
  })

  it('isoParaLocal: nulo e inválido viram vazio', () => {
    expect(isoParaLocal(null)).toBe('')
    expect(isoParaLocal('nao-e-data')).toBe('')
  })
})

describe('resumoPublico', () => {
  const seg = (c: string): string => `S:${c}`
  const q = (c: string): string => `Q:${c}`

  it('sem filtro diz que é a base inteira', () => {
    expect(resumoPublico(PUBLICO_VAZIO, seg, q)).toEqual(['Toda a base de contatos (menos as exclusões automáticas)'])
  })

  it('uma linha por tipo, OU dentro do tipo', () => {
    const l = resumoPublico({
      ...PUBLICO_VAZIO, segmentos: ['a', 'b'], etiquetas: [{ valor: '1', rotulo: 'VIP' }], qualificacao: ['novo'],
      semInteracaoDias: '1', criadoDe: '2026-01-01', criadoAte: '2026-02-01',
    }, seg, q)
    expect(l).toEqual([
      'Segmento: S:a ou S:b', 'Etiqueta: VIP', 'Qualificação: Q:novo', 'Sem interação há 1 dia ou mais',
      'Criado a partir de 2026-01-01 até 2026-02-01',
    ])
  })
})

describe('template do número oficial', () => {
  it('só marketing aprovado serve', () => {
    expect(templateServeParaCampanha({ categoria: 'MARKETING', statusMeta: 'APPROVED' })).toBe(true)
    expect(templateServeParaCampanha({ categoria: 'UTILITY', statusMeta: 'APPROVED' })).toBe(false)
    expect(templateServeParaCampanha({ categoria: 'MARKETING', statusMeta: 'PENDING' })).toBe(false)
  })

  it('variáveis do corpo sem mapeamento aparecem antes de salvar', () => {
    const corpo = 'Oi {{1}}, seu pedido {{2}} e {{1}} de novo. {{ 3 }}'
    expect(variaveisDoCorpo(corpo)).toEqual([1, 2, 3])
    expect(variaveisSemMapeamento(corpo, { '1': 'nome' })).toEqual([2, 3])
    expect(variaveisSemMapeamento('sem variável', undefined)).toEqual([])
  })

  it('busca local ignora acento e caixa', () => {
    expect(casaComTermo('Reativação de Clientes', 'reativacao')).toBe(true)
    expect(casaComTermo('Reativação', 'xyz')).toBe(false)
    expect(casaComTermo('qualquer', '  ')).toBe(true)
  })
})

describe('destinatário', () => {
  it('o marco é o evento mais recente do ciclo', () => {
    const base: DestinatarioApi = {
      id: '1', contatoId: 'c', contatoNome: 'Ana', estado: 'lida', motivoExclusao: null, erroCodigo: null, conversaId: null,
      enviadoEm: '2026-11-01T10:00:00Z', entregueEm: '2026-11-01T10:01:00Z', lidoEm: '2026-11-01T11:00:00Z', respondeuEm: null, optoutEm: null,
    }
    expect(marcoDoDestinatario(base)).toBe('2026-11-01T11:00:00Z')
    expect(marcoDoDestinatario({ ...base, lidoEm: null, entregueEm: null })).toBe('2026-11-01T10:00:00Z')
  })
})

describe('bloqueio do número (campanha em curso parada pelo número)', () => {
  it('cada motivo vira título e ação corretiva', () => {
    expect(avisoDeBloqueio({ motivo: 'numero_desconectado' })?.acao).toMatch(/Reconecte o número em Meus Números/)
    expect(avisoDeBloqueio({ motivo: 'numero_sem_credencial' })?.acao).toMatch(/Conecte o número/)
    expect(avisoDeBloqueio({ motivo: 'disparo_pausado' })?.acao).toMatch(/Retomar disparo/)
    expect(avisoDeBloqueio({ motivo: 'sem_numero' })?.acao).toMatch(/Cancele a campanha/)
    expect(avisoDeBloqueio({ motivo: 'numero_arquivado' })?.titulo).toMatch(/arquivado/)
  })

  it('sem bloqueio não há aviso; motivo novo cai num texto genérico, nunca em branco', () => {
    expect(avisoDeBloqueio(null)).toBeNull()
    expect(avisoDeBloqueio({ motivo: 'algo_novo' })?.titulo).toMatch(/Envio parado/)
  })
})

describe('pausa de risco e janela ajustada', () => {
  it('só numero_em_risco é pausa de risco', () => {
    expect(ehPausaDeRisco('numero_em_risco')).toBe(true)
    expect(ehPausaDeRisco('qualidade_numero')).toBe(false)
    expect(ehPausaDeRisco(null)).toBe(false)
  })

  it('a faixa de risco diz que a Meta sinalizou o número e pede cautela', () => {
    expect(AVISO_PAUSA_DE_RISCO.titulo).toMatch(/Meta sinalizou o número/)
    expect(AVISO_PAUSA_DE_RISCO.acao).toMatch(/banir/)
  })

  it('janela ajustada cita 08:00–21:00 e o limite de marketing; sem ajuste, sem aviso', () => {
    expect(avisoJanelaAjustada(true)).toMatch(/Janela ajustada para 08:00–21:00 \(limite de marketing\)/)
    expect(avisoJanelaAjustada(false)).toBeNull()
    expect(avisoJanelaAjustada(undefined)).toBeNull()
  })
})

describe('janela da campanha — erros da tela e da API', () => {
  it('fora de 08:00–21:00 aponta o campo janela, no passo Envio', () => {
    const fora = { ...oficial, janelaPropria: true, janela: { seg: { de: '07:00', ate: '12:00' } } }
    expect(errosDoPasso('envio', fora)['janela']).toMatch(/08:00 e 21:00/)
    expect(errosDoPasso('envio', { ...oficial, janelaPropria: true, janela: { seg: { de: '08:00', ate: '21:00' } } })).toEqual({})
  })

  it('422 janela_vazia e janela_fora_do_permitido voltam ao campo janela, no passo Envio', () => {
    for (const erro of ['campanha.janela_vazia', 'campanha.janela_fora_do_permitido']) {
      const r = mapearErro({ erro, campos: { janela: 'Mensagem do campo.' } }, 'x')
      expect(r.campos).toEqual({ janela: 'Mensagem do campo.' })
      expect(r.passo).toBe('envio')
    }
  })
})

describe('erros de ação com texto próprio', () => {
  it('iniciar: a campanha mudou enquanto iniciava', () => {
    expect(mensagemDeAcao('campanha.alterada_durante_inicio', null, 'x'))
      .toBe('A campanha mudou enquanto iniciava; revise e tente de novo.')
  })

  it('teste com limite: diz os limites que vieram na resposta, sem campo', () => {
    const r = erroDoTeste('campanha.teste_limite', { limiteUsuarioHora: 20, limiteNumeroHora: 30 }, 'x')
    expect(r.campo).toBeNull()
    expect(r.mensagem).toMatch(/até 20 telefones por pessoa e 30 por número/)
  })

  it('teste sem cota: aquecimento e teto do dia, com a saída', () => {
    expect(erroDoTeste('campanha.teste_sem_cota', null, 'x').mensagem).toMatch(/aquecimento.*teto de hoje/)
  })

  it('telefones inválidos apontam o campo telefones; sem código, a mensagem da API ou o padrão', () => {
    expect(erroDoTeste('campanha.teste_invalido', { campos: { telefones: 'De 1 a 5 telefones.' } }, 'x'))
      .toEqual({ campo: 'telefones', mensagem: 'De 1 a 5 telefones.' })
    expect(erroDoTeste(null, { mensagem: 'Oi.' }, 'x').mensagem).toBe('Oi.')
    expect(erroDoTeste(null, null, 'padrão').mensagem).toBe('padrão')
  })
})
