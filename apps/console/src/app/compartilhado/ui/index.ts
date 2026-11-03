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
export {
  PROVEDORES_IA, QUALIDADE_MAX, rotuloProvedor, pontosQualidade, rotuloQualidade, formatarUsd, linhaDeCusto,
  agruparPorPreco, badgesDoModelo, permitidosDe, alternarCodigo, codigosParaSalvar, mudouPermissao,
  type ModeloIa, type ModeloComPermissao, type ProvedorIa,
} from './modelos-ia.regras.js'
export { FormPaginaComponente } from './form-pagina.componente.js'
export { SecaoFormComponente } from './secao-form.componente.js'
export { GradeFormComponente } from './grade-form.componente.js'
export { BreadcrumbComponente } from './breadcrumb.componente.js'
export { itensDaTrilha, type ItemTrilha, type ItemTrilhaVista } from './breadcrumb.regras.js'
export { ModalComponente, type LarguraModal } from './modal.componente.js'
export { AbasComponente } from './abas.componente.js'
export { abaAtiva, proximaAba, type Aba } from './abas.regras.js'
export { ListaDefinicaoComponente, valorDefinicao, type ItemDefinicao } from './lista-definicao.componente.js'
export { ChipsEtiquetaComponente, alternarChip, type OpcaoChip } from './chips-etiqueta.componente.js'
export { focaveisDe, primeiroAlvoDeFoco, prenderTab, devolverFoco } from './foco.js'
