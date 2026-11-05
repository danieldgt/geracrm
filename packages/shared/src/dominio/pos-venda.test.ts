import { describe, it, expect } from 'vitest'
import {
  DIAS_DEPOIS_MAX, MAX_TEXTO_AUTOMACAO, VALIDADE_PROVA_SOCIAL_DIAS, ehDetratorNps, errosFormatoProvaSocial, errosParaAprovarProvaSocial,
  provaSocialVigente, validarAcaoAgenteEnvia, validarGatilhoPedidoEfetivado, vetosProvaSocial,
  ESPALHAMENTO_POS_VENDA_MS, espalhamentoDoPosVenda, fontesDaProvaSocial,
} from './pos-venda.js'

describe('revisão G3 — regras puras', () => {
  it('B1: prova social abona contagem e %, nunca prazo (nem dinheiro)', () => {
    const f = fontesDaProvaSocial(['Mais de 1.200 lojas, 98% recomendam, entrega em 48 horas e 3 dias úteis.'])
    expect(f.numeros).toContain(1200)
    expect(f.numeros).not.toContain(48)
    expect(f.numeros).not.toContain(3)
    expect(f.percentuais).toEqual([98])
  })
  it('M3: espalhamento determinístico, em minutos inteiros, dentro de 2 h', () => {
    const a = espalhamentoDoPosVenda('c1:p1:nps')
    expect(espalhamentoDoPosVenda('c1:p1:nps')).toBe(a)
    expect(a % 60_000).toBe(0)
    expect(a).toBeGreaterThanOrEqual(0)
    expect(a).toBeLessThan(ESPALHAMENTO_POS_VENDA_MS)
    const distintos = new Set(Array.from({ length: 50 }, (_, i) => espalhamentoDoPosVenda(`c${i}:p:nps`)))
    expect(distintos.size).toBeGreaterThan(20)
  })
})
import { ACOES_TODAS_LIGADAS, acoesPlaybook, ROTULO_ACAO } from './agente-playbook.js'

const TPL = '0193a000-0000-7000-8000-000000000001'
const AGORA = new Date('2026-10-20T15:00:00Z')

describe('validarGatilhoPedidoEfetivado', () => {
  it('ausente = 0; 0..60 inteiros valem', () => {
    expect(validarGatilhoPedidoEfetivado({})).toEqual({ ok: true, dados: { diasDepois: 0 } })
    expect(validarGatilhoPedidoEfetivado({ diasDepois: DIAS_DEPOIS_MAX })).toEqual({ ok: true, dados: { diasDepois: 60 } })
    expect(validarGatilhoPedidoEfetivado({ diasDepois: '7' })).toEqual({ ok: true, dados: { diasDepois: 7 } })
  })
  it.each([-1, 61, 2.5, 'abc'])('%j → erro no campo diasDepois', (v) => {
    expect(validarGatilhoPedidoEfetivado({ diasDepois: v })).toMatchObject({ ok: false, campo: 'gatilhoParam.diasDepois' })
  })
})

describe('validarAcaoAgenteEnvia', () => {
  it('roteiro + texto, ou roteiro + template; normaliza vazios para null', () => {
    expect(validarAcaoAgenteEnvia({ roteiro: 'nps', texto: ' Nota? ', templateId: '' })).toEqual({ ok: true, dados: { roteiro: 'nps', texto: 'Nota?', templateId: null } })
    expect(validarAcaoAgenteEnvia({ roteiro: 'indicacao', templateId: TPL })).toEqual({ ok: true, dados: { roteiro: 'indicacao', texto: null, templateId: TPL } })
  })
  it('sem roteiro válido, sem conteúdo, texto longo ou template malformado → erro nomeado', () => {
    expect(validarAcaoAgenteEnvia({ roteiro: 'cupom', texto: 'x' })).toMatchObject({ ok: false, campo: 'acaoParam.roteiro' })
    expect(validarAcaoAgenteEnvia({ roteiro: 'nps' })).toMatchObject({ ok: false, campo: 'acaoParam.texto' })
    expect(validarAcaoAgenteEnvia({ roteiro: 'nps', texto: 'x'.repeat(MAX_TEXTO_AUTOMACAO + 1) })).toMatchObject({ ok: false, campo: 'acaoParam.texto' })
    expect(validarAcaoAgenteEnvia({ roteiro: 'nps', templateId: 'abc' })).toMatchObject({ ok: false, campo: 'acaoParam.templateId' })
    expect(validarAcaoAgenteEnvia(null)).toMatchObject({ ok: false })
  })
})

describe('NPS', () => {
  it('detrator é 0 a 6', () => {
    expect([0, 6, 7, 10].map(ehDetratorNps)).toEqual([true, true, false, false])
  })
})

describe('prova social', () => {
  it('vigência: hoje e até a validade valem; futuro, velha demais e formato ruim não', () => {
    expect(provaSocialVigente('2026-10-20', AGORA)).toBe(true)
    const limite = new Date(AGORA.getTime() - VALIDADE_PROVA_SOCIAL_DIAS * 86_400_000).toISOString().slice(0, 10)
    expect(provaSocialVigente(limite, AGORA)).toBe(true)
    expect(provaSocialVigente('2025-10-01', AGORA)).toBe(false)
    expect(provaSocialVigente('2026-10-21', AGORA)).toBe(false)
    expect(provaSocialVigente('20/10/2026', AGORA)).toBe(false)
    expect(provaSocialVigente(null, AGORA)).toBe(false)
  })

  it('vetos: afirmação absoluta, superlativo, "número 1", resultado garantido e o filtro base do agente', () => {
    expect(vetosProvaSocial('Loja sem reclamações desde 2010.')).toHaveLength(1)
    expect(vetosProvaSocial('100% dos clientes satisfeitos.').length).toBeGreaterThan(0)
    expect(vetosProvaSocial('Somos a maior do Brasil em uniformes.').length).toBeGreaterThan(0)
    expect(vetosProvaSocial('Número 1 em atendimento.').length).toBeGreaterThan(0)
    expect(vetosProvaSocial('Entrega garantida em 24 horas para todo o Brasil.').length).toBeGreaterThan(0)
    expect(vetosProvaSocial('98% dos clientes nos recomendam (Pesquisa NPS 2026).')).toEqual([])
    expect(vetosProvaSocial('"Atendimento rápido e atencioso" — Maria, Fortaleza.')).toEqual([])
  })

  it('formato: link http(s), data AAAA-MM-DD, tipo da lista', () => {
    expect(errosFormatoProvaSocial({ link: 'ftp://x' }).map((e) => e.campo)).toEqual(['link'])
    expect(errosFormatoProvaSocial({ apuradoEm: '2026-13-45' }).map((e) => e.campo)).toEqual(['apuradoEm'])
    expect(errosFormatoProvaSocial({ link: 'https://ok.test/a', apuradoEm: '2026-10-01', provaTipo: 'numero' })).toEqual([])
  })

  it('para aprovar: fonte, data não futura, tipo, consentimento do depoimento e texto sem veto', () => {
    const base = { conteudo: '98% recomendam.', fonte: 'NPS', link: null, apuradoEm: '2026-10-01', provaTipo: 'numero' as const, consentimento: false }
    expect(errosParaAprovarProvaSocial(base, AGORA)).toEqual([])
    expect(errosParaAprovarProvaSocial({ ...base, fonte: ' ' }, AGORA).map((e) => e.campo)).toEqual(['fonte'])
    expect(errosParaAprovarProvaSocial({ ...base, apuradoEm: '2026-12-01' }, AGORA).map((e) => e.campo)).toEqual(['apuradoEm'])
    expect(errosParaAprovarProvaSocial({ ...base, provaTipo: null }, AGORA).map((e) => e.campo)).toEqual(['provaTipo'])
    expect(errosParaAprovarProvaSocial({ ...base, provaTipo: 'depoimento' }, AGORA).map((e) => e.campo)).toEqual(['consentimento'])
    expect(errosParaAprovarProvaSocial({ ...base, provaTipo: 'depoimento', consentimento: true }, AGORA)).toEqual([])
    expect(errosParaAprovarProvaSocial({ ...base, conteudo: 'Sem reclamações.' }, AGORA).map((e) => e.campo)).toEqual(['conteudo'])
  })
})

describe('ações do playbook (G3)', () => {
  it('⚠️ versão publicada ANTES da G3 (sem as chaves novas) continua válida — ligadas por padrão', () => {
    const antigo = { catalogo: true, pedido: true, proposta: true, memoria: false, conhecimento: true }
    // ⚠️ indicações nasce DESLIGADA (escrita nova na base); NPS e prova social ligadas (já têm portão).
    expect(acoesPlaybook.parse(antigo)).toEqual({ ...antigo, objecoes: true, nps: true, indicacoes: false, provaSocial: true })
    expect(ACOES_TODAS_LIGADAS.indicacoes).toBe(false)
  })
  it('desligáveis, e cada uma diz qual ferramenta tira do menu', () => {
    expect(acoesPlaybook.parse({ ...ACOES_TODAS_LIGADAS, nps: false })).toMatchObject({ nps: false })
    expect(ROTULO_ACAO.nps.ferramentas).toEqual(['registrar_nps'])
    expect(ROTULO_ACAO.indicacoes.ferramentas).toEqual(['registrar_indicacoes'])
    expect(ROTULO_ACAO.provaSocial.ferramentas).toEqual(['consultar_prova_social'])
  })
  it('chave desconhecida continua recusada (strict)', () => {
    expect(acoesPlaybook.safeParse({ ...ACOES_TODAS_LIGADAS, efetivar: true }).success).toBe(false)
  })
})
