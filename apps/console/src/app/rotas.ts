import type { Type } from '@angular/core'
import type { Routes } from '@angular/router'
import { ShellComponente } from './nucleo/shell.componente.js'
import { itensDoMenu } from './nucleo/menu.js'
import { guardaAuth } from './nucleo/auth.guarda.js'

/**
 * Rotas GERADAS do config de menu — a mesma fonte que desenha a lateral.
 *
 * ⚠️ Telas 'pronto' carregam o componente real (lazy). Todas as outras caem no
 * placeholder "em construção", com título/descrição vindos do `data` da rota.
 * Assim o menu inteiro é navegável desde já, sem 40 componentes vazios e sem
 * rota que "não faz nada".
 */

// As telas reais já construídas. Lazy para não pesar o bundle inicial.
const TELAS_REAIS: Record<string, () => Promise<Type<unknown>>> = {
  conversas: () =>
    import('./funcionalidades/atendimento/inbox.pagina.js').then((m) => m.InboxPagina),
  numeros: () =>
    import('./funcionalidades/atendimento/canais.pagina.js').then((m) => m.CanaisPagina),
  pedido: () =>
    import('./funcionalidades/pedido/pedido.pagina.js').then((m) => m.PedidoAssistidoPagina),
  'fila-do-dia': () =>
    import('./funcionalidades/crm/fila-do-dia.pagina.js').then((m) => m.FilaDoDiaPagina),
  contatos: () =>
    import('./funcionalidades/crm/clientes.pagina.js').then((m) => m.ClientesPagina),
  integracao: () =>
    import('./funcionalidades/integracao/conexoes.pagina.js').then((m) => m.ConexoesPagina),
  auditoria: () =>
    import('./funcionalidades/plataforma/auditoria.pagina.js').then((m) => m.AuditoriaPagina),
  bloqueios: () =>
    import('./funcionalidades/crm/bloqueios.pagina.js').then((m) => m.BloqueiosPagina),
  webhooks: () =>
    import('./funcionalidades/integracao/webhooks.pagina.js').then((m) => m.WebhooksPagina),
  funil: () =>
    import('./funcionalidades/crm/funil.pagina.js').then((m) => m.FunilPagina),
  crm: () =>
    import('./funcionalidades/crm/leads.pagina.js').then((m) => m.LeadsPagina),
  'crm-avancado': () =>
    import('./funcionalidades/crm/crm-avancado.pagina.js').then((m) => m.CrmAvancadoPagina),
  templates: () =>
    import('./funcionalidades/atendimento/templates.pagina.js').then((m) => m.TemplatesPagina),
  'atendimento-kanban': () =>
    import('./funcionalidades/atendimento/atendimento-kanban.pagina.js').then((m) => m.AtendimentoKanbanPagina),
  campanhas: () =>
    import('./funcionalidades/campanha/campanhas.pagina.js').then((m) => m.CampanhasPagina),
  pedidos: () =>
    import('./funcionalidades/pedido/pedidos.pagina.js').then((m) => m.PedidosPagina),
  catalogo: () =>
    import('./funcionalidades/catalogo/catalogo.pagina.js').then((m) => m.CatalogoPagina),
  midia: () =>
    import('./funcionalidades/aquisicao/midia.pagina.js').then((m) => m.MidiaPagina),
  segmentos: () =>
    import('./funcionalidades/crm/segmentos.pagina.js').then((m) => m.SegmentosPagina),
  inicio: () =>
    import('./funcionalidades/painel/inicio.pagina.js').then((m) => m.InicioPagina),
  tarefas: () =>
    import('./funcionalidades/crm/tarefas.pagina.js').then((m) => m.TarefasPagina),
  carteiras: () =>
    import('./funcionalidades/crm/carteiras.pagina.js').then((m) => m.CarteirasPagina),
  metas: () =>
    import('./funcionalidades/crm/metas.pagina.js').then((m) => m.MetasPagina),
  listas: () =>
    import('./funcionalidades/crm/listas.pagina.js').then((m) => m.ListasPagina),
  bi: () =>
    import('./funcionalidades/analitico/bi.pagina.js').then((m) => m.BiPagina),
  performance: () =>
    import('./funcionalidades/analitico/performance.pagina.js').then((m) => m.PerformancePagina),
  mercado: () =>
    import('./funcionalidades/analitico/mercado.pagina.js').then((m) => m.MercadoPagina),
  mapa: () =>
    import('./funcionalidades/analitico/mapa.pagina.js').then((m) => m.MapaPagina),
  retencao: () =>
    import('./funcionalidades/crm/retencao.pagina.js').then((m) => m.RetencaoPagina),
  nps: () =>
    import('./funcionalidades/crm/nps.pagina.js').then((m) => m.NpsPagina),
  sequencias: () =>
    import('./funcionalidades/crm/sequencias.pagina.js').then((m) => m.SequenciasPagina),
  'canal-config': () =>
    import('./funcionalidades/atendimento/canal-config.pagina.js').then((m) => m.CanalConfigPagina),
  'agente': () =>
    import('./funcionalidades/atendimento/agente.pagina.js').then((m) => m.AgentePagina),
  mensagens: () =>
    import('./funcionalidades/atendimento/mensagens-enviadas.pagina.js').then((m) => m.MensagensEnviadasPagina),
  config: () =>
    import('./funcionalidades/plataforma/config.pagina.js').then((m) => m.ConfigPagina),
  automacoes: () =>
    import('./funcionalidades/crm/automacoes.pagina.js').then((m) => m.AutomacoesPagina),
  fidelidade: () =>
    import('./funcionalidades/crm/fidelidade.pagina.js').then((m) => m.FidelidadePagina),
}

const rotasFilhas = itensDoMenu()
  // ⚠️ Item de rail (Conversas) NÃO gera rota — o chat vive na casca como rail.
  .filter((item) => item.acao !== 'rail')
  .map((item) => {
  const real = TELAS_REAIS[item.rota]
  if (item.status === 'pronto' && real) {
    return { path: item.rota, loadComponent: real }
  }
  return {
    path: item.rota,
    loadComponent: () =>
      import('./compartilhado/em-construcao.pagina.js').then((m) => m.EmConstrucaoPagina),
    // ⚠️ O placeholder lê isto — mesma descrição do menu, sem duplicar.
    data: { rotulo: item.rotulo, descricao: item.descricao, icone: item.icone, onda: item.onda },
  }
})

export const ROTAS: Routes = [
  // Login fica FORA da casca (sem menu) — e sem guard, senão laço infinito.
  {
    path: 'login',
    loadComponent: () => import('./nucleo/login.pagina.js').then((m) => m.LoginPagina),
  },
  {
    path: '',
    component: ShellComponente,
    // ⚠️ Em produção exige ID token do Cognito; em dev (localhost) libera.
    canActivate: [guardaAuth],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'contatos' },
      // Link antigo /conversas (bookmarks) → base; o chat agora é o rail lateral.
      { path: 'conversas', pathMatch: 'full', redirectTo: 'contatos' },
      // Ficha do contato: rota de detalhe (não vai no menu). `id` liga ao input
      // do componente via withComponentInputBinding.
      {
        path: 'contato/:id',
        loadComponent: () =>
          import('./funcionalidades/crm/ficha.pagina.js').then((m) => m.FichaContatoPagina),
      },
      // ROI de um anúncio (AQ-16): detalhe, não vai no menu — chega pela lista
      // de Mídia paga.
      {
        path: 'midia/anuncio/:id',
        loadComponent: () =>
          import('./funcionalidades/aquisicao/anuncio-roi.pagina.js').then((m) => m.AnuncioRoiPagina),
      },
      ...rotasFilhas,
      // Rota desconhecida volta para a base — não deixa tela órfã.
      { path: '**', redirectTo: 'contatos' },
    ],
  },
]
