import { describe, expect, it } from 'vitest'
import {
  ACAO_SEM_FORMULARIO, FILTROS_CONTATOS_VAZIOS, FORM_ACAO_VAZIO, acoesVisiveis, corpoDaAcao, filtrosDaQuery, idsDoLote,
  paramsDaApi, periodoInvalido, queryDosFiltros, temFiltroAtivo, textoResultadoAcao, tomQualificacao, validarAcao,
  type FiltrosContatos,
} from './clientes.regras.js'

const V = 'a2e00000-0005-4000-8000-000000000003'
const E1 = 'a2e00000-0008-4000-8000-000000000001'
const E2 = 'a2e00000-0008-4000-8000-000000000002'
const ids = ['c1', 'c2']

describe('filtros ↔ query params', () => {
  it('query vazia = sem filtro; sem filtro = query vazia', () => {
    expect(filtrosDaQuery({})).toEqual(FILTROS_CONTATOS_VAZIOS)
    expect(queryDosFiltros(FILTROS_CONTATOS_VAZIOS)).toEqual({})
    expect(temFiltroAtivo(FILTROS_CONTATOS_VAZIOS)).toBe(false)
  })

  it('ida e volta preserva todos os filtros (o link compartilhado reproduz a lista)', () => {
    const f: FiltrosContatos = {
      q: 'ana', qualificacao: 'novo', segmento: 'em-risco', vendedorId: V, filialId: E1, origemId: E2,
      etiquetaIds: [E1, E2], semProximoPasso: true, criadoDe: '2026-01-01', criadoAte: '2026-02-01',
    }
    const q = queryDosFiltros(f)
    expect(q['etiquetaId']).toEqual([E1, E2])
    expect(q['semProximoPasso']).toBe('true')
    expect(filtrosDaQuery(q)).toEqual(f)
    expect(temFiltroAtivo(f)).toBe(true)
  })

  it('vendedor "sem-dono" é valor válido', () => {
    expect(filtrosDaQuery({ vendedorId: 'sem-dono' }).vendedorId).toBe('sem-dono')
  })

  it('link adulterado cai em "sem filtro", nunca em 422', () => {
    const f = filtrosDaQuery({
      qualificacao: 'xxx', segmento: 'toString', vendedorId: 'não-uuid', filialId: '1', origemId: '2',
      etiquetaId: ['x', E1], semProximoPasso: 'talvez', criadoDe: 'ontem', criadoAte: '2026-13-45x',
    })
    expect(f).toEqual({ ...FILTROS_CONTATOS_VAZIOS, etiquetaIds: [E1] })
  })

  it('uma etiqueta só na URL vem como string; repetidas, no máximo 5, sem duplicar', () => {
    expect(filtrosDaQuery({ etiquetaId: E1 }).etiquetaIds).toEqual([E1])
    const seis = Array.from({ length: 6 }, (_, i) => `a2e00000-0008-4000-8000-00000000010${i}`)
    expect(filtrosDaQuery({ etiquetaId: [...seis, seis[0]!] }).etiquetaIds).toHaveLength(5)
  })

  it('paramsDaApi: limite, cursor, filtros e etiquetaId repetido', () => {
    const f = { ...FILTROS_CONTATOS_VAZIOS, q: 'ana silva', etiquetaIds: [E1, E2], semProximoPasso: true }
    const p = new URLSearchParams(paramsDaApi(f, 'abc', 30))
    expect(p.get('limite')).toBe('30')
    expect(p.get('cursor')).toBe('abc')
    expect(p.get('q')).toBe('ana silva')
    expect(p.getAll('etiquetaId')).toEqual([E1, E2])
    expect(p.get('semProximoPasso')).toBe('true')
    expect(new URLSearchParams(paramsDaApi(FILTROS_CONTATOS_VAZIOS, null)).has('cursor')).toBe(false)
  })

  it('período invertido é detectado antes de ir à API', () => {
    expect(periodoInvalido({ ...FILTROS_CONTATOS_VAZIOS, criadoDe: '2026-05-02', criadoAte: '2026-05-01' })).toBe(true)
    expect(periodoInvalido({ ...FILTROS_CONTATOS_VAZIOS, criadoDe: '2026-05-01' })).toBe(false)
  })
})

describe('ações por papel', () => {
  it('vendedor não vê transferir nem criar tarefa; a gestão vê todas', () => {
    const vendedor = acoesVisiveis(false).map((a) => a.acao)
    expect(vendedor).toEqual(['qualificar', 'descartar', 'reabrir', 'etiquetar', 'adicionar-lista'])
    const gestao = acoesVisiveis(true).map((a) => a.acao)
    expect(gestao).toContain('transferir')
    expect(gestao).toContain('criar-tarefa')
    expect(gestao).toHaveLength(7)
  })

  it('qualificar e reabrir não pedem formulário; as outras sim', () => {
    expect(ACAO_SEM_FORMULARIO('qualificar')).toBe(true)
    expect(ACAO_SEM_FORMULARIO('reabrir')).toBe(true)
    expect(ACAO_SEM_FORMULARIO('descartar')).toBe(false)
    expect(ACAO_SEM_FORMULARIO('transferir')).toBe(false)
  })
})

describe('idsDoLote', () => {
  it('respeita o teto de 500 e avisa do excedente', () => {
    const muitos = new Set(Array.from({ length: 501 }, (_, i) => `id${i}`))
    const r = idsDoLote(muitos)
    expect(r.ids).toHaveLength(500)
    expect(r.excedeu).toBe(true)
    expect(idsDoLote(new Set(['a'])).excedeu).toBe(false)
  })
})

describe('corpo de cada ação', () => {
  const form = { ...FORM_ACAO_VAZIO }

  it('qualificar e reabrir: só os ids', () => {
    expect(corpoDaAcao('qualificar', ids, form)).toEqual({ contatoIds: ids })
    expect(corpoDaAcao('reabrir', ids, form)).toEqual({ contatoIds: ids })
  })

  it('sem ids nenhuma ação monta corpo', () => {
    expect(corpoDaAcao('qualificar', [], form)).toBeNull()
  })

  it('descartar exige motivo e observação (aparada)', () => {
    expect(corpoDaAcao('descartar', ids, form)).toBeNull()
    expect(corpoDaAcao('descartar', ids, { ...form, motivo: 'sem_interesse' })).toBeNull()
    expect(corpoDaAcao('descartar', ids, { ...form, motivo: 'sem_interesse', observacao: '   ' })).toBeNull()
    expect(corpoDaAcao('descartar', ids, { ...form, motivo: 'sem_interesse', observacao: ' não quer ' }))
      .toEqual({ contatoIds: ids, motivo: 'sem_interesse', observacao: 'não quer' })
    expect(validarAcao('descartar', form)).toMatchObject({ motivo: expect.any(String), observacao: expect.any(String) })
  })

  it('transferir: usuário + motivo', () => {
    expect(corpoDaAcao('transferir', ids, { ...form, usuarioId: V })).toBeNull()
    expect(corpoDaAcao('transferir', ids, { ...form, usuarioId: V, motivo: ' Redistribuição ' }))
      .toEqual({ contatoIds: ids, usuarioId: V, motivo: 'Redistribuição' })
    expect(Object.keys(validarAcao('transferir', form)).sort()).toEqual(['motivo', 'usuarioId'])
  })

  it('etiquetar e desetiquetar: etiquetaIds', () => {
    expect(corpoDaAcao('etiquetar', ids, form)).toBeNull()
    expect(corpoDaAcao('etiquetar', ids, { ...form, etiquetaIds: [E1, E2] })).toEqual({ contatoIds: ids, etiquetaIds: [E1, E2] })
    expect(corpoDaAcao('desetiquetar', ids, { ...form, etiquetaIds: [E1] })).toEqual({ contatoIds: ids, etiquetaIds: [E1] })
    expect(validarAcao('etiquetar', form).etiquetaIds).toBeTruthy()
  })

  it('adicionar-lista: listaId', () => {
    expect(corpoDaAcao('adicionar-lista', ids, form)).toBeNull()
    expect(corpoDaAcao('adicionar-lista', ids, { ...form, listaId: E1 })).toEqual({ contatoIds: ids, listaId: E1 })
    expect(validarAcao('adicionar-lista', form).listaId).toBeTruthy()
  })

  it('criar-tarefa: título + data/hora viram ISO; opcionais só quando preenchidos', () => {
    expect(corpoDaAcao('criar-tarefa', ids, form)).toBeNull()
    const ok = { ...form, titulo: ' Reativar ', data: '2026-12-01', hora: '10:30' }
    const c = corpoDaAcao('criar-tarefa', ids, ok)!
    expect(c).toMatchObject({ contatoIds: ids, titulo: 'Reativar', tipo: 'outro' })
    expect(c['venceEm']).toBe(new Date('2026-12-01T10:30').toISOString())
    expect(c).not.toHaveProperty('responsavelId')
    expect(c).not.toHaveProperty('descricao')
    const cheio = corpoDaAcao('criar-tarefa', ids, { ...ok, tipo: 'whatsapp', responsavelId: V, descricao: ' x ' })!
    expect(cheio).toMatchObject({ tipo: 'whatsapp', responsavelId: V, descricao: 'x' })
    expect(Object.keys(validarAcao('criar-tarefa', { ...form, hora: '' })).sort()).toEqual(['data', 'hora', 'titulo'])
  })

  it('o corpo nunca carrega tenant nem preço', () => {
    for (const a of ['qualificar', 'descartar', 'transferir', 'etiquetar', 'adicionar-lista', 'criar-tarefa'] as const) {
      const c = corpoDaAcao(a, ids, {
        ...form, motivo: 'x', observacao: 'x', usuarioId: V, etiquetaIds: [E1], listaId: E1, titulo: 'x', data: '2026-12-01',
      })
      expect(JSON.stringify(c)).not.toMatch(/tenant|preco|price/i)
    }
  })
})

describe('textos', () => {
  it('resultado: o que mudou e quantos ficaram de fora', () => {
    expect(textoResultadoAcao({ aplicados: 3, ignorados: 0 })).toBe('3 contatos alterados.')
    expect(textoResultadoAcao({ aplicados: 1, ignorados: 1 })).toContain('1 contato alterado; 1 ficou de fora')
    expect(textoResultadoAcao({ aplicados: 0, ignorados: 2 })).toContain('Nenhum contato foi alterado; 2 ficaram de fora')
  })

  it('tom do selo de qualificação', () => {
    expect(tomQualificacao('qualificado')).toBe('sucesso')
    expect(tomQualificacao('descartado')).toBe('erro')
    expect(tomQualificacao('novo')).toBe('neutro')
  })
})
