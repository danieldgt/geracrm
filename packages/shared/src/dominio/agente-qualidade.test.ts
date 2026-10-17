import { describe, it, expect } from 'vitest'
import {
  avaliarRegrasQualidade, piorGravidade, perguntasJaRespondiveis, fracaoEstavel, naAmostra, amostraEfetiva,
  interpretarRubrica, notaMedia, ordenarAmostraSemanal, mascararTextoQualidade, esquemaRubricaJson, CRITERIOS_RUBRICA,
  MAX_JUSTIFICATIVA, type ConversaAvaliada,
} from './agente-qualidade.js'

const regras = (mensagens: string[], extra: Partial<Parameters<typeof avaliarRegrasQualidade>[0]> = {}) =>
  avaliarRegrasQualidade({ mensagens, ...extra })
const codigos = (v: ReturnType<typeof avaliarRegrasQualidade>) => v.map((x) => `${x.gravidade}:${x.regra}:${x.detalhe ?? ''}`)

describe('regras de qualidade (ADR-031) — o que escapou do pipeline', () => {
  it('resposta limpa: nenhuma violação', () => {
    expect(regras(['Temos a caixa de 12 unidades. Quantas você quer?'])).toEqual([])
  })

  it('frase proibida da base P2 que chegou ao texto final é CRÍTICA', () => {
    const v = regras(['Garantimos entrega amanhã para você.'])
    expect(v[0]).toMatchObject({ regra: 'palavra_proibida', gravidade: 'CRITICA' })
    expect(piorGravidade(v)).toBe('CRITICA')
  })

  it('negação vale: "não garantimos entrega amanhã" passa', () => {
    expect(regras(['Não garantimos entrega amanhã, mas o vendedor confirma o prazo.']).filter((x) => x.gravidade === 'CRITICA')).toEqual([])
  })

  it('extras do número contam', () => {
    expect(codigos(regras(['Fazemos frete de cortesia.'], { extras: ['frete de cortesia'] }))[0]).toMatch(/^CRITICA:palavra_proibida/)
  })

  it('lista B2B a mais: venda sem nota é CRÍTICA; negada não', () => {
    expect(codigos(regras(['Dá para fazer sem nota fiscal, fica mais barato.']))).toContain('CRITICA:palavra_proibida:venda_sem_nota')
    expect(regras(['Não vendemos sem nota fiscal.'])).toEqual([])
    expect(codigos(regras(['Seu crédito aprovado na hora!']))).toContain('CRITICA:palavra_proibida:credito_na_hora')
    expect(codigos(regras(['É uma compra sem risco.']))).toContain('ALTA:palavra_proibida:sem_risco')
  })

  it('promessa de prazo por data é ALTA; condicional, negada e pergunta não', () => {
    expect(codigos(regras(['Seu pedido chega amanhã.']))).toContain('ALTA:promessa_prazo:prazo de entrega por data')
    expect(regras(['Se fechar agora, sai amanhã?'])).toEqual([])
    expect(regras(['Caso o pagamento compense, chega na sexta.']).filter((x) => x.regra === 'promessa_prazo')).toEqual([])
    expect(regras(['O pedido não sai hoje.']).filter((x) => x.regra === 'promessa_prazo')).toEqual([])
  })

  it('promessa de prazo de retorno do atendimento é ALTA', () => {
    expect(codigos(regras(['Um vendedor te chama em 5 minutos.']))).toContain('ALTA:promessa_prazo:prazo de retorno do atendimento')
  })

  it('número sem fonte: bloqueante CRÍTICA, demais ALTA; sem fontes a regra não roda', () => {
    const fontes = { gerais: [], percentuais: [], doCliente: [] }
    expect(regras(['Dou 10% de desconto.'], { fontes }).some((x) => x.regra === 'numero_sem_fonte' && x.gravidade === 'CRITICA')).toBe(true)
    expect(regras(['Temos 30 unidades.'], { fontes: { gerais: [30] } }).filter((x) => x.regra === 'numero_sem_fonte')).toEqual([])
    expect(regras(['Temos 30 unidades.']).filter((x) => x.regra === 'numero_sem_fonte')).toEqual([])
  })

  it('pergunta repetida e várias perguntas são MEDIA', () => {
    const v = regras(['Qual a quantidade que você precisa? E para quando?'], { perguntasAnteriores: ['Qual quantidade você precisa?'] })
    expect(codigos(v)).toEqual(expect.arrayContaining(['MEDIA:pergunta_repetida:', 'MEDIA:multiplas_perguntas:2 perguntas']))
  })

  it('pergunta de pedido pode voltar (o pedido mudou) — mesma exceção da trava P3', () => {
    expect(regras(['Adicionei mais 2 caixas. Posso fechar o pedido?'], { perguntasAnteriores: ['Posso fechar o pedido?'] })).toEqual([])
  })

  it('várias perguntas contam no TURNO (mensagens separadas)', () => {
    expect(regras(['Qual a cidade?', 'E o CNPJ?']).map((x) => x.regra)).toContain('multiplas_perguntas')
  })

  it('mensagem longa pelo limite do número', () => {
    expect(codigos(regras(['a'.repeat(400)], { maxCaracteres: 320 }))).toContain('MEDIA:mensagem_longa:400 caracteres (máx. 320)')
    expect(regras(['a'.repeat(400)])).toEqual([])
  })

  it('texto fixo do sistema (abertura) é isento', () => {
    const abertura = 'Olá! Sou a Lia, assistente virtual da Loja. Seus dados seguem nossa política: https://x.y/p?id=1. Posso ajudar? Quer ver o catálogo?'
    expect(regras([abertura, 'Temos sim!'], { isentas: [abertura], maxCaracteres: 50 })).toEqual([])
  })

  it('trecho sai mascarado e curto', () => {
    const v = regras([`Garantimos entrega amanhã, liga no 85 99999-1234 ou manda para a@b.com. ${'x'.repeat(300)}`])
    expect(v[0]!.trecho).not.toMatch(/99999|a@b\.com/)
    expect(v[0]!.trecho.length).toBeLessThanOrEqual(160)
  })

  it('perguntas já respondíveis: só as feitas antes de uma fala do cliente', () => {
    expect(perguntasJaRespondiveis([
      { de: 'nos', texto: 'Qual a cidade?' }, { de: 'cliente', texto: 'Fortaleza' }, { de: 'nos', texto: 'E o volume?' },
    ])).toEqual(['Qual a cidade?'])
  })
})

describe('máscara', () => {
  it('tira telefone, CPF, CNPJ e e-mail; mantém dinheiro e quantidade', () => {
    const t = mascararTextoQualidade('Fone +55 (85) 99999-1234, CPF 123.456.789-09, CNPJ 12.345.678/0001-90, x@y.com.br, R$ 1.234,56 e 12 caixas')
    expect(t).toBe('Fone [telefone], CPF [cpf], CNPJ [cnpj], [e-mail], R$ 1.234,56 e 12 caixas')
  })
})

describe('amostra estável (FNV-1a)', () => {
  it('FNV-1a conhecido e em [0,1)', () => {
    expect(fracaoEstavel('')).toBeCloseTo(0x811c9dc5 / 2 ** 32, 12)
    expect(fracaoEstavel('a')).toBeCloseTo(0xe40c292c / 2 ** 32, 12)
  })

  it('a mesma conversa sempre cai (ou nunca cai); a fração aproxima a amostra', () => {
    const ids = Array.from({ length: 4000 }, (_, i) => `0198a3c0-0000-7000-8000-${String(i).padStart(12, '0')}`)
    const caiu = ids.filter((id) => naAmostra(id, 0.2))
    expect(ids.filter((id) => naAmostra(id, 0.2))).toEqual(caiu)
    expect(caiu.length / ids.length).toBeGreaterThan(0.15)
    expect(caiu.length / ids.length).toBeLessThan(0.25)
    // Aumentar a amostra só ACRESCENTA conversas: quem estava continua.
    const em50 = new Set(ids.filter((id) => naAmostra(id, 0.5)))
    expect(caiu.every((id) => em50.has(id))).toBe(true)
    expect(naAmostra(ids[0]!, 1)).toBe(true)
    expect(naAmostra(ids[0]!, 0)).toBe(false)
  })

  it('amostra efetiva: a do número ou o padrão do modo', () => {
    expect(amostraEfetiva(null, 'sombra')).toBe(1)
    expect(amostraEfetiva(null, 'assistido')).toBe(0.2)
    expect(amostraEfetiva(null, 'autonomo')).toBe(0.05)
    expect(amostraEfetiva(0.5, 'autonomo')).toBe(0.5)
    expect(amostraEfetiva(3, 'autonomo')).toBe(1)
  })
})

describe('rubrica do juiz', () => {
  const saida = Object.fromEntries(CRITERIOS_RUBRICA.map((c, i) => [c, { nota: i + 0.6, justificativa: `ok ${c}` }]))

  it('normaliza: inteiro 0–5, justificativa ≤ 280 e mascarada', () => {
    const n = interpretarRubrica({ ...saida, clareza: { nota: 9, justificativa: `liga 85 99999-1234 ${'x'.repeat(400)}` } })!
    expect(n.aderencia.nota).toBe(1)
    expect(n.clareza.nota).toBe(5)
    expect(n.clareza.justificativa.length).toBeLessThanOrEqual(MAX_JUSTIFICATIVA)
    expect(n.clareza.justificativa).not.toMatch(/99999/)
    expect(notaMedia(n)).toBe(Math.round(((1 + 5 + 3 + 4 + 5) / 5) * 100) / 100)
  })

  it('aceita JSON em texto e recusa formato faltando critério', () => {
    expect(interpretarRubrica('```json\n' + JSON.stringify(saida) + '\n```')).not.toBeNull()
    expect(interpretarRubrica({ clareza: { nota: 3 } })).toBeNull()
    expect(interpretarRubrica('sem json')).toBeNull()
  })

  it('schema simples, 5 critérios obrigatórios', () => {
    expect((esquemaRubricaJson()['required'] as string[]).length).toBe(5)
  })
})

describe('ordem da amostra semanal', () => {
  const item = (id: string, g: ConversaAvaliada['piorGravidade'], nota: number | null = null): ConversaAvaliada =>
    ({ conversaId: id, piorGravidade: g, menorNota: nota })

  it('CRÍTICA → ALTA/nota ≤ 3 até 8 → aleatórias até 20, estável pela semente', () => {
    const itens: ConversaAvaliada[] = [
      ...Array.from({ length: 3 }, (_, i) => item(`c${i}`, 'CRITICA')),
      ...Array.from({ length: 6 }, (_, i) => item(`a${i}`, 'ALTA')),
      ...Array.from({ length: 6 }, (_, i) => item(`n${i}`, 'MEDIA', 2.4)),
      ...Array.from({ length: 30 }, (_, i) => item(`r${i}`, null, 4.5)),
    ]
    const a = ordenarAmostraSemanal(itens, '2026-W42')
    expect(a).toHaveLength(20)
    expect(a.slice(0, 3).every((x) => x.motivo === 'critica')).toBe(true)
    expect(a.filter((x) => x.motivo === 'alta_ou_nota_baixa')).toHaveLength(8)
    expect(a.slice(3, 11).every((x) => x.motivo === 'alta_ou_nota_baixa')).toBe(true)
    expect(a.slice(11).every((x) => x.motivo === 'aleatoria')).toBe(true)
    expect(ordenarAmostraSemanal(itens, '2026-W42')).toEqual(a)
    expect(new Set(a.map((x) => x.conversaId)).size).toBe(20)
  })

  it('poucas conversas: devolve todas, sem repetir', () => {
    expect(ordenarAmostraSemanal([item('x', null), item('y', 'CRITICA')], 's').map((x) => x.conversaId)).toEqual(['y', 'x'])
  })
})
