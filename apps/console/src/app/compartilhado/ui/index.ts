// Biblioteca de componentes — bloco 1 (R-12). Import único.
export { BotaoComponente } from './botao.componente.js'
export { CampoComponente } from './campo.componente.js'
export { BadgeComponente } from './badge.componente.js'
export { PainelComponente } from './painel.componente.js'
export { EsqueletoComponente } from './esqueleto.componente.js'
export { CabecalhoTelaComponente } from './cabecalho-tela.componente.js'
export { EstadoComponente } from './estado.componente.js'
export { ToastServico, ToastsComponente, type Toast } from './toast.js'
export { ConfirmacaoServico, ConfirmarComponente } from './confirmar.componente.js'
export { mesclarPagina, queryDeLista } from './cursor.js'
export { reaisParaCentavos, centavosParaReais, formatarReais } from './dinheiro.js'
export { corpoDoErro, codigoDoErro, mensagemDeErro, ehStatus, type ErroApi } from './erro-http.js'
export { HorarioAtendimentoComponente, somenteDiasAbertos, DIAS,
         type Faixa, type HorarioAtendimento } from './horario-atendimento.componente.js'
export { QualidadeComponente } from './qualidade.componente.js'
// Componentes de lista (L0c) — padrão Lista do plano de paridade.
export { TabelaComponente, CelulaDiretiva, type ColunaTabela, type LinhaTabela } from './tabela.componente.js'
export { FiltrosComponente, DEBOUNCE_BUSCA_MS } from './filtros.componente.js'
export { PaginacaoComponente } from './paginacao.componente.js'
export { AcoesLoteComponente } from './acoes-lote.componente.js'
export { StatCardComponente, type TomStat } from './stat-card.componente.js'
export { FiltroPeriodoComponente } from './filtro-periodo.componente.js'
export { BotaoCsvComponente } from './botao-csv.componente.js'
export { paraCsv, baixarCsv, type ColunaCsv, type OpcoesCsv } from './csv.js'
export { periodoDoAtalho, atalhoAtivo, hojeIso, ATALHOS_PERIODO, type AtalhoPeriodo, type Periodo } from './periodo.js'
export { estadoSelecaoPagina, alternarPagina, alternarChave, textoMostrando, textoSelecionados, comDebounce } from './lista.regras.js'
export {
  PROVEDORES_IA, QUALIDADE_MAX, rotuloProvedor, pontosQualidade, rotuloQualidade, formatarUsd, linhaDeCusto,
  agruparPorPreco, badgesDoModelo, permitidosDe, alternarCodigo, codigosParaSalvar, mudouPermissao,
  type ModeloIa, type ModeloComPermissao, type ProvedorIa,
} from './modelos-ia.regras.js'
