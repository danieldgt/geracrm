import { describe, it, expect } from 'vitest'
import {
  FILTROS_TIPO, badgeAprovacao, badgeTipo, corpoDoDocumento, formularioDe, formularioNovo, linhaDaFonte, pendenciasParaAprovar,
  tipoDoFiltro, tiposDisponiveis, validarDocumento,
} from './conhecimento.regras.js'

/** Regras puras da PROVA SOCIAL na aba Conhecimento (G3). */
const CANAL = '0199a3f0-0b1c-7000-8000-00000000c0a2'
const AGORA = new Date('2026-10-20T15:00:00Z')
const prova = { ...formularioNovo(CANAL, 'prova_social'), titulo: 'NPS', conteudo: '98% recomendam.' }

describe('Prova social — tipo e filtro', () => {
  it('é um tipo do Conhecimento, com rótulo, oferecido nos dois alcances', () => {
    expect(badgeTipo('prova_social')).toEqual({ rotulo: 'Prova social', tom: 'info' })
    expect(tiposDisponiveis('canal')).toContain('prova_social')
    expect(tiposDisponiveis('global')).toContain('prova_social')
  })
  it('filtro "Prova social" vira ?tipo=prova_social; "Todos" não filtra', () => {
    expect(FILTROS_TIPO.map((f) => f.rotulo)).toEqual(['Todos', 'Prova social'])
    expect(tipoDoFiltro('prova_social')).toBe('prova_social')
    expect(tipoDoFiltro('todos')).toBeNull()
  })
  it('"Nova prova social" abre o formulário já no tipo, com número e sem consentimento', () => {
    expect(formularioNovo(CANAL, 'prova_social')).toMatchObject({ tipo: 'prova_social', provaTipo: 'numero', consentimento: false, fonte: '' })
  })
})

describe('Prova social — formulário', () => {
  it('rascunho incompleto pode ser salvo; link e data malformados não', () => {
    expect(validarDocumento(prova)).toEqual({})
    expect(validarDocumento({ ...prova, link: 'ftp://x' })).toHaveProperty('link')
    expect(validarDocumento({ ...prova, apuradoEm: '2026-02-31x' })).toHaveProperty('apuradoEm')
    // Em outro tipo, os campos da prova são ignorados.
    expect(validarDocumento({ ...prova, tipo: 'faq', link: 'ftp://x' })).toEqual({})
  })
  it('corpo: vazio vira null; consentimento só vai em depoimento; fora do tipo, nada da prova vai', () => {
    expect(corpoDoDocumento({ ...prova, fonte: ' NPS 2026 ', consentimento: true }, CANAL)).toEqual({
      titulo: 'NPS', tipo: 'prova_social', conteudo: '98% recomendam.', canalId: CANAL,
      fonte: 'NPS 2026', link: null, apuradoEm: null, provaTipo: 'numero', consentimento: false,
    })
    expect(corpoDoDocumento({ ...prova, provaTipo: 'depoimento', consentimento: true }, CANAL)).toMatchObject({ consentimento: true })
    expect(corpoDoDocumento({ ...prova, tipo: 'faq' }, CANAL)).not.toHaveProperty('fonte')
  })
  it('editar carrega os campos do documento (tolerando API sem eles)', () => {
    const f = formularioDe({ id: 'd', titulo: 'T', tipo: 'prova_social', canalId: null, conteudo: 'c', fonte: 'G', link: 'https://x.test', apuradoEm: '2026-10-01', provaTipo: 'depoimento', consentimento: true })
    expect(f).toMatchObject({ fonte: 'G', link: 'https://x.test', apuradoEm: '2026-10-01', provaTipo: 'depoimento', consentimento: true })
    expect(formularioDe({ id: 'd', titulo: 'T', tipo: 'prova_social', canalId: null, conteudo: 'c' })).toMatchObject({ fonte: '', provaTipo: 'numero' })
  })
})

describe('Prova social — aprovação', () => {
  const doc = { tipo: 'prova_social', conteudo: '98% recomendam.', fonte: 'NPS', apuradoEm: '2026-10-01', provaTipo: 'numero', consentimento: false }
  it('selo: pendente, aprovada, aprovada mas vencida; outros tipos sem selo', () => {
    expect(badgeAprovacao({ ...doc, aprovado: false }, AGORA)).toEqual({ rotulo: 'pendente de aprovação', tom: 'atencao' })
    expect(badgeAprovacao({ ...doc, aprovado: true }, AGORA)).toEqual({ rotulo: 'aprovada', tom: 'sucesso' })
    expect(badgeAprovacao({ ...doc, aprovado: true, apuradoEm: '2025-01-01' }, AGORA)).toEqual({ rotulo: 'aprovada — vencida', tom: 'erro' })
    expect(badgeAprovacao({ ...doc, tipo: 'faq', aprovado: false }, AGORA)).toBeNull()
  })
  it('o que falta para aprovar, com a mesma regra da API', () => {
    expect(pendenciasParaAprovar(doc, AGORA)).toEqual([])
    expect(pendenciasParaAprovar({ ...doc, fonte: null, apuradoEm: null }, AGORA)).toHaveLength(2)
    expect(pendenciasParaAprovar({ ...doc, provaTipo: 'depoimento' }, AGORA)).toEqual([expect.stringContaining('consentimento')])
    expect(pendenciasParaAprovar({ ...doc, conteudo: 'Sem reclamações.' }, AGORA)).toHaveLength(1)
  })
  it('linha da fonte: "fonte · apurado em dd/mm/aaaa"', () => {
    expect(linhaDaFonte({ fonte: 'NPS 2026', apuradoEm: '2026-10-01' })).toBe('NPS 2026 · apurado em 01/10/2026')
    expect(linhaDaFonte({ fonte: null, apuradoEm: null })).toBeNull()
  })
})
