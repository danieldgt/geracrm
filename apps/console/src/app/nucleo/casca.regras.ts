/**
 * Regras PURAS da casca no celular (menu-gaveta, trilho de conversas, alertas).
 *
 * ⚠️ Sem Angular aqui: o componente só liga sinais e DOM a estas decisões. Assim
 * "quando a gaveta fecha" e "o que o voltar faz" são testados sem montar tela.
 */

/** Abaixo desta largura (px) a casca entra no modo celular. Desktop (>= 720) não muda. */
export const LARGURA_CELULAR = 720

/** Media query equivalente — a única fonte do corte, usada pelo matchMedia da casca. */
export const MQ_CELULAR = `(max-width: ${LARGURA_CELULAR - 0.02}px)`

export function ehCelular(larguraJanela: number): boolean {
  return larguraJanela < LARGURA_CELULAR
}

/**
 * O que acontece com a gaveta do menu.
 * - `alternar`: o botão ☰ (ou o ✕ dentro da gaveta);
 * - `esc` / `clique-fora` / `navegou`: fecham — a pessoa escolheu ou desistiu;
 * - `virou-desktop`: a janela cresceu; a gaveta deixa de existir, fica fechada
 *   para não reaparecer aberta se a janela voltar a encolher.
 */
export type EventoGaveta = 'alternar' | 'esc' | 'clique-fora' | 'navegou' | 'virou-desktop'

export function proximaGaveta(aberta: boolean, evento: EventoGaveta, celular: boolean): boolean {
  if (!celular) return false
  switch (evento) {
    case 'alternar': return !aberta
    case 'esc':
    case 'clique-fora':
    case 'navegou':
    case 'virou-desktop':
      return false
  }
}

/**
 * Foco preso na gaveta aberta: Tab no último volta ao primeiro, Shift+Tab no
 * primeiro vai ao último. Devolve o índice que deve receber foco, ou `null`
 * quando o navegador pode seguir sozinho (foco no meio da lista).
 *
 * `atual` = -1 quando o foco está FORA da gaveta (ex.: clicou no véu) — aí o
 * foco volta para dentro, no começo (Tab) ou no fim (Shift+Tab).
 */
export function focoPreso(atual: number, total: number, voltando: boolean): number | null {
  if (total <= 0) return null
  if (atual < 0) return voltando ? total - 1 : 0
  if (voltando && atual === 0) return total - 1
  if (!voltando && atual === total - 1) return 0
  return null
}

/** Texto do contador de não lidas no botão flutuante: vazio sem nada, teto em 99+. */
export function rotuloContador(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ''
  return n > 99 ? '99+' : String(Math.floor(n))
}

/** Rótulo acessível do botão flutuante — diz a contagem, não só o ícone. */
export function rotuloBotaoConversas(n: number): string {
  const c = rotuloContador(n)
  if (!c) return 'Abrir conversas'
  return `Abrir conversas — ${c} não ${n === 1 ? 'lida' : 'lidas'}`
}

/**
 * O "voltar" do trilho no celular sobe UM nível: da conversa para a lista, da
 * lista para fora (fecha o trilho). Assim um mesmo gesto nunca pula a lista.
 */
export type AcaoVoltar = 'voltar-para-lista' | 'fechar-trilho'

export function acaoVoltar(temConversaAberta: boolean): AcaoVoltar {
  return temConversaAberta ? 'voltar-para-lista' : 'fechar-trilho'
}

/**
 * Onde mora o ‹ no celular: UM por nível, nunca dois na tela.
 * - lista à vista → ‹ no cabeçalho da LISTA do inbox, que FECHA o trilho;
 * - conversa aberta em largura total → o ‹ do topo da conversa (o do próprio
 *   inbox) volta à lista, e o cabeçalho da lista some junto com a lista.
 * O trilho não desenha ‹ próprio no celular (o cabeçalho dele nem aparece:
 * seria um segundo "Conversas"). No desktop o trilho fecha pelo ›.
 */
export function voltarNoCabecalhoDaLista(celular: boolean, dentroDoTrilho: boolean): AcaoVoltar | null {
  // Fora do trilho (a rota /conversas aberta direto) não há trilho a fechar.
  return celular && dentroDoTrilho ? 'fechar-trilho' : null
}

/**
 * Camadas (z-index) da casca no celular, em relação aos modais das telas.
 *
 * ⚠️ Os modais das telas (fundo escuro + painel) usam de 40 para cima. O botão
 * flutuante de conversas fica ABAIXO deles: com um modal aberto, o fundo escuro
 * cobre o botão — nem tapa o canto do modal nem abre o trilho por cima de um
 * diálogo. O trilho ABERTO (tela cheia) fica acima dos modais; a gaveta e o
 * véu, acima de tudo da casca.
 */
export const CAMADA = {
  /** Piso dos modais das telas — todo elemento fixo de tela fica em >= 40. */
  modal: 40,
  trilhoRecolhido: 30,
  trilhoAberto: 60,
  veu: 90,
  gaveta: 100,
} as const

export function camadaTrilho(aberto: boolean): number {
  return aberto ? CAMADA.trilhoAberto : CAMADA.trilhoRecolhido
}

/**
 * O que fica `inert` atrás de algo que se comporta como modal no celular: a
 * gaveta do menu aberta OU o trilho de conversas aberto em tela cheia. Sem
 * isso o Tab leva o foco para botões escondidos atrás.
 */
export function conteudoInerte(celular: boolean, gavetaAberta: boolean, trilhoAberto: boolean): boolean {
  return gavetaAberta || (celular && trilhoAberto)
}

export interface AlertaResumo {
  readonly severidade: 'aviso' | 'critico'
}

/**
 * Faixa de alertas no celular: o CRÍTICO fica sempre à vista; os demais viram
 * uma linha "N alertas" recolhível. No desktop nada recolhe (`recolhiveis` vazio).
 */
export function separarAlertas<A extends AlertaResumo>(
  alertas: readonly A[],
  celular: boolean,
): { readonly sempreVisiveis: readonly A[]; readonly recolhiveis: readonly A[] } {
  if (!celular) return { sempreVisiveis: alertas, recolhiveis: [] }
  return {
    sempreVisiveis: alertas.filter((a) => a.severidade === 'critico'),
    recolhiveis: alertas.filter((a) => a.severidade !== 'critico'),
  }
}

/** "1 alerta" / "N alertas" — com "outro(s)" quando já há crítico à vista acima. */
export function resumoAlertas(n: number, haCriticoVisivel: boolean): string {
  if (haCriticoVisivel) return n === 1 ? '1 outro alerta' : `${n} outros alertas`
  return n === 1 ? '1 alerta' : `${n} alertas`
}
