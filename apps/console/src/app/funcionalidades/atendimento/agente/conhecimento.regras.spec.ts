import { describe, it, expect } from 'vitest'
import {
  ARQUIVO_MAX_BYTES, LIMIAR_FORCA, LIMITES_DOCUMENTO, TIPOS_DOCUMENTO,
  ajustarTipoAoAlcance, arquivoGrande, badgeAlcance, badgeForca, badgeTipo, corpoDoDocumento, descreverMotivoSemantica,
  ehEspelhoDePoliticas, forcaDoScore, formularioDe, formularioNovo, fraseCapacidade, motivoSemantica, resumoDaExtracao,
  rotuloFonte, rotuloSemantica, temPendentes, textoPendentes, tipoArquivoDe, tiposDisponiveis, validarDocumento,
} from './conhecimento.regras.js'

const CANAL = '0199a3f0-0b1c-7000-8000-00000000c0a1'

describe('Tipo de documento: rótulo e badge', () => {
  it('todo tipo da API tem rótulo em pt-BR', () => {
    for (const t of TIPOS_DOCUMENTO) expect(badgeTipo(t).rotulo).not.toBe(t)
  })
  it('dado tipo desconhecido (API mais nova), então sai cru e neutro — a lista não quebra', () => {
    expect(badgeTipo('garantia')).toEqual({ rotulo: 'garantia', tom: 'neutro' })
  })
  it('políticas se destaca (info); os demais são neutros', () => {
    expect(badgeTipo('politicas').tom).toBe('info')
    expect(badgeTipo('faq').tom).toBe('neutro')
  })
})

describe('Alcance e o espelho de políticas', () => {
  it('dado alcance "este número", então o select NÃO oferece políticas (a API recusaria)', () => {
    expect(tiposDisponiveis('canal')).not.toContain('politicas')
    expect(tiposDisponiveis('global')).toContain('politicas')
  })
  it('dado políticas escolhido e alcance trocado para número, então cai para "outro"', () => {
    expect(ajustarTipoAoAlcance('politicas', 'canal')).toBe('outro')
    expect(ajustarTipoAoAlcance('frete', 'canal')).toBe('frete')
    expect(ajustarTipoAoAlcance('politicas', 'global')).toBe('politicas')
  })
  it('espelho = políticas COM canal; políticas global e faq do canal não são', () => {
    expect(ehEspelhoDePoliticas({ tipo: 'politicas', canalId: CANAL })).toBe(true)
    expect(ehEspelhoDePoliticas({ tipo: 'politicas', canalId: null })).toBe(false)
    expect(ehEspelhoDePoliticas({ tipo: 'faq', canalId: CANAL })).toBe(false)
  })
  it('badge de alcance: global × este número', () => {
    expect(badgeAlcance({ canalId: null }).rotulo).toBe('global')
    expect(badgeAlcance({ canalId: CANAL }).rotulo).toBe('este número')
  })
})

describe('Capacidade da busca: o que a tela diz', () => {
  const ligada = {
    pgvector: true, embedding: { configurado: true, provedor: 'voyage', falta: null }, semantica: 'ligada',
    pendentes: { produtos: 0, trechos: 0 }, embutidos: { produtos: 10, trechos: 3 },
  }
  const semChave = { ...ligada, embedding: { configurado: false, provedor: null, falta: 'VOYAGE_API_KEY' }, semantica: 'sem_chave' }
  const semPgvector = { ...ligada, pgvector: false, semantica: 'sem_pgvector' }

  it('rótulo curto: lexical × lexical + semântica', () => {
    expect(rotuloSemantica(ligada)).toBe('Busca lexical + semântica')
    expect(rotuloSemantica(semChave)).toBe('Busca lexical')
    expect(rotuloSemantica(semPgvector)).toBe('Busca lexical')
  })
  it('motivo NOMEIA a variável que falta; sem pgvector nomeia o Postgres; ligada é null', () => {
    expect(motivoSemantica(semChave)).toBe('Falta VOYAGE_API_KEY no servidor')
    expect(motivoSemantica(semPgvector)).toBe('Postgres sem pgvector')
    expect(motivoSemantica(ligada)).toBeNull()
  })
  it('dado sem_chave sem o nome da variável, então assume VOYAGE_API_KEY', () => {
    expect(motivoSemantica({ semantica: 'sem_chave' })).toBe('Falta VOYAGE_API_KEY no servidor')
  })
  it('motivo da resposta de buscar: capacidade_desligada tem frase; desconhecido sai cru', () => {
    expect(descreverMotivoSemantica('capacidade_desligada')).toBe('Embedding não configurado no servidor')
    expect(descreverMotivoSemantica('limite_excedido')).toBe('limite_excedido')
    expect(descreverMotivoSemantica('ligada')).toBeNull()
  })
  it('frase da aba Configuração: uma linha, com o motivo em minúscula entre parênteses', () => {
    expect(fraseCapacidade(semChave)).toBe('busca lexical — semântica desligada (falta VOYAGE_API_KEY no servidor)')
    expect(fraseCapacidade(ligada)).toBe('busca lexical + semântica')
  })
  it('pendentes: zero nos dois é "sem pendentes"; o texto lista trechos e produtos', () => {
    expect(temPendentes(ligada)).toBe(false)
    expect(temPendentes({ pendentes: { produtos: 0, trechos: 2 } })).toBe(true)
    expect(textoPendentes({ pendentes: { produtos: 340, trechos: 12 } })).toBe('pendentes: 12 trechos · 340 produtos')
  })
})

describe('Força do trecho (RRF com k = 60 produz valores pequenos)', () => {
  it('1º em duas pernas (~0,0328) é forte', () => {
    expect(forcaDoScore(1 / 61 + 1 / 61)).toBe('forte')
  })
  it('1º em uma perna só (~0,0164) é médio', () => {
    expect(forcaDoScore(1 / 61)).toBe('medio')
  })
  it('5º em uma perna só (~0,0154) é fraco', () => {
    expect(forcaDoScore(1 / 65)).toBe('fraco')
  })
  it('as fronteiras são inclusivas; NaN e Infinity negativo caem em fraco', () => {
    expect(forcaDoScore(LIMIAR_FORCA.forte)).toBe('forte')
    expect(forcaDoScore(LIMIAR_FORCA.medio)).toBe('medio')
    expect(forcaDoScore(LIMIAR_FORCA.medio - 1e-9)).toBe('fraco')
    expect(forcaDoScore(Number.NaN)).toBe('fraco')
    expect(forcaDoScore(Number.NEGATIVE_INFINITY)).toBe('fraco')
  })
  it('badge: forte=sucesso, médio=info, fraco=neutro, com acento no rótulo', () => {
    expect(badgeForca(0.04)).toEqual({ rotulo: 'forte', tom: 'sucesso' })
    expect(badgeForca(0.02)).toEqual({ rotulo: 'médio', tom: 'info' })
    expect(badgeForca(0.001)).toEqual({ rotulo: 'fraco', tom: 'neutro' })
  })
  it('rótulo de fonte: semântica ganha acento; desconhecida sai crua', () => {
    expect(rotuloFonte('semantica')).toBe('semântica')
    expect(rotuloFonte('lexical')).toBe('lexical')
    expect(rotuloFonte('bm25')).toBe('bm25')
  })
})

describe('Tipo do arquivo importado', () => {
  it('MIME dos três aceitos vale direto', () => {
    expect(tipoArquivoDe('x.bin', 'text/plain')).toBe('text/plain')
    expect(tipoArquivoDe('x', 'text/markdown')).toBe('text/markdown')
    expect(tipoArquivoDe('x', 'application/pdf')).toBe('application/pdf')
  })
  it('dado MIME vazio (como o navegador manda para .md), então decide a extensão', () => {
    expect(tipoArquivoDe('politicas.md', '')).toBe('text/markdown')
    expect(tipoArquivoDe('politicas.markdown', null)).toBe('text/markdown')
    expect(tipoArquivoDe('faq.txt', undefined)).toBe('text/plain')
    expect(tipoArquivoDe('tabela.pdf', '')).toBe('application/pdf')
  })
  it('extensão em MAIÚSCULA e MIME genérico também resolvem pela extensão', () => {
    expect(tipoArquivoDe('FRETE.PDF', 'application/octet-stream')).toBe('application/pdf')
    expect(tipoArquivoDe('Leia.Me.TXT', '')).toBe('text/plain')
    expect(tipoArquivoDe('notas.md', 'text/x-markdown')).toBe('text/markdown')
  })
  it('não aceito: docx, sem extensão, ponto no fim', () => {
    expect(tipoArquivoDe('contrato.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBeNull()
    expect(tipoArquivoDe('semextensao', '')).toBeNull()
    expect(tipoArquivoDe('estranho.', '')).toBeNull()
  })
  it('teto de 6 MB: igual passa, um byte a mais não', () => {
    expect(arquivoGrande(ARQUIVO_MAX_BYTES)).toBe(false)
    expect(arquivoGrande(ARQUIVO_MAX_BYTES + 1)).toBe(true)
  })
  it('resumo da extração: milhar com ponto, páginas só quando PDF, singular em 1', () => {
    expect(resumoDaExtracao({ caracteres: 3214, paginas: 4 })).toBe('3.214 caracteres · 4 páginas')
    expect(resumoDaExtracao({ caracteres: 980, paginas: null })).toBe('980 caracteres')
    expect(resumoDaExtracao({ caracteres: 1234567, paginas: 1 })).toBe('1.234.567 caracteres · 1 página')
  })
})

describe('Validação do documento (mesmos limites da API)', () => {
  it('título e conteúdo preenchidos: sem erros', () => {
    expect(validarDocumento({ titulo: 'Frete', conteudo: 'Entregamos em 3 dias.' })).toEqual({})
  })
  it('vazio ou só espaços: erro nos dois campos', () => {
    const e = validarDocumento({ titulo: '   ', conteudo: '\n\t' })
    expect(Object.keys(e).sort()).toEqual(['conteudo', 'titulo'])
  })
  it('limites: 200 no título passa, 201 não; 150.000 no conteúdo passa, 150.001 não', () => {
    expect(validarDocumento({ titulo: 'a'.repeat(LIMITES_DOCUMENTO.tituloMax), conteudo: 'x' })).toEqual({})
    expect(validarDocumento({ titulo: 'a'.repeat(LIMITES_DOCUMENTO.tituloMax + 1), conteudo: 'x' })['titulo']).toContain('200')
    expect(validarDocumento({ titulo: 't', conteudo: 'x'.repeat(LIMITES_DOCUMENTO.conteudoMax) })).toEqual({})
    expect(validarDocumento({ titulo: 't', conteudo: 'x'.repeat(LIMITES_DOCUMENTO.conteudoMax + 1) })['conteudo']).toContain('150.000')
  })
  it('espaços nas pontas não contam para o limite (a API faz trim antes de medir)', () => {
    expect(validarDocumento({ titulo: ` ${'a'.repeat(200)} `, conteudo: 'x' })).toEqual({})
  })
})

describe('Formulário ↔ corpo da API', () => {
  it('novo com número selecionado começa valendo só para ele; sem número, global', () => {
    expect(formularioNovo(CANAL).alcance).toBe('canal')
    expect(formularioNovo('').alcance).toBe('global')
  })
  it('corpo: trim nos textos; canalId só quando alcance é número E há número', () => {
    const f = { id: null, titulo: '  Frete ', tipo: 'frete' as const, alcance: 'canal' as const, conteudo: ' x ' }
    expect(corpoDoDocumento(f, CANAL)).toEqual({ titulo: 'Frete', tipo: 'frete', conteudo: 'x', canalId: CANAL })
    expect(corpoDoDocumento({ ...f, alcance: 'global' }, CANAL).canalId).toBeNull()
    expect(corpoDoDocumento(f, '').canalId).toBeNull()
  })
  it('editar: carrega do documento; tipo desconhecido vira "outro" sem perder o texto', () => {
    const f = formularioDe({ id: 'd1', titulo: 'T', tipo: 'garantia', canalId: null, conteudo: 'c' })
    expect(f).toEqual({ id: 'd1', titulo: 'T', tipo: 'outro', alcance: 'global', conteudo: 'c' })
    expect(formularioDe({ id: 'd2', titulo: 'T', tipo: 'faq', canalId: CANAL, conteudo: 'c' }).alcance).toBe('canal')
  })
})
