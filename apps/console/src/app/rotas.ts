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
/**
 * ⚠️ Exportado para o teste: tela registrada aqui e marcada como `construcao` no
 * menu fica ESCONDIDA atrás do placeholder, sem erro nenhum. Ver `rotas.spec.ts`.
 */
export const TELAS_REAIS: Record<string, () => Promise<Type<unknown>>> = {
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
  'etiquetas-origens': () =>
    import('./funcionalidades/crm/etiquetas-origens.pagina.js').then((m) => m.EtiquetasOrigensPagina),
  webhooks: () =>
    import('./funcionalidades/integracao/webhooks.pagina.js').then((m) => m.WebhooksPagina),
  importar: () =>
    import('./funcionalidades/integracao/importacao.pagina.js').then((m) => m.ImportacaoPagina),
  funil: () =>
    import('./funcionalidades/crm/funil.pagina.js').then((m) => m.FunilPagina),
  crm: () =>
    import('./funcionalidades/crm/leads.pagina.js').then((m) => m.LeadsPagina),
  'crm-avancado': () =>
    import('./funcionalidades/crm/crm-avancado.pagina.js').then((m) => m.CrmAvancadoPagina),
  templates: () =>
    import('./funcionalidades/atendimento/templates.pagina.js').then((m) => m.TemplatesPagina),
  cockpit: () =>
    import('./funcionalidades/gestao/cockpit.pagina.js').then((m) => m.CockpitPagina),
  'carteira-higienizacao': () =>
    import('./funcionalidades/gestao/carteira-higienizacao.pagina.js').then((m) => m.CarteiraHigienizacaoPagina),
  'atendimento-kanban': () =>
    import('./funcionalidades/atendimento/atendimento-kanban.pagina.js').then((m) => m.AtendimentoKanbanPagina),
  campanhas: () =>
    import('./funcionalidades/campanha/campanhas.pagina.js').then((m) => m.CampanhasPagina),
  consumo: () =>
    import('./funcionalidades/consumo/consumo.pagina.js').then((m) => m.ConsumoPagina),
  pedidos: () =>
    import('./funcionalidades/pedido/pedidos.pagina.js').then((m) => m.PedidosPagina),
  catalogo: () =>
    import('./funcionalidades/catalogo/catalogo.pagina.js').then((m) => m.CatalogoPagina),
  midia: () =>
    import('./funcionalidades/aquisicao/midia.pagina.js').then((m) => m.MidiaPagina),
  formularios: () =>
    import('./funcionalidades/aquisicao/formularios.pagina.js').then((m) => m.FormulariosPagina),
  segmentos: () =>
    import('./funcionalidades/crm/segmentos.pagina.js').then((m) => m.SegmentosPagina),
  inicio: () =>
    import('./funcionalidades/painel/inicio.pagina.js').then((m) => m.InicioPagina),
  usuarios: () =>
    import('./funcionalidades/acesso/usuarios.pagina.js').then((m) => m.UsuariosPagina),
  filiais: () =>
    import('./funcionalidades/acesso/filiais.pagina.js').then((m) => m.FiliaisPagina),
  tarefas: () =>
    import('./funcionalidades/crm/tarefas.pagina.js').then((m) => m.TarefasPagina),
  agenda: () =>
    import('./funcionalidades/agenda/agenda.pagina.js').then((m) => m.AgendaPagina),
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
  relatorios: () =>
    import('./funcionalidades/analitico/relatorios.pagina.js').then((m) => m.RelatoriosPagina),
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
    import('./funcionalidades/atendimento/agente/agente.pagina.js').then((m) => m.AgentePagina),
  mensagens: () =>
    import('./funcionalidades/atendimento/mensagens-enviadas.pagina.js').then((m) => m.MensagensEnviadasPagina),
  config: () =>
    import('./funcionalidades/plataforma/config.pagina.js').then((m) => m.ConfigPagina),
  'clientes-plataforma': () =>
    import('./funcionalidades/plataforma/clientes.pagina.js').then((m) => m.ClientesPlataformaPagina),
  automacoes: () =>
    import('./funcionalidades/crm/automacoes.pagina.js').then((m) => m.AutomacoesPagina),
  fidelidade: () =>
    import('./funcionalidades/crm/fidelidade.pagina.js').then((m) => m.FidelidadePagina),
  'catalogo-produtos': () =>
    import('./funcionalidades/catalogo/catalogo-produtos.pagina.js').then((m) => m.CatalogoProdutosPagina),
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
  // Formulário PÚBLICO (F3): fora da casca, sem guard — quem preenche não tem conta.
  // ⚠️ Só `/f/<chave>` é o formulário (e só ele pode ir para iframe, ver nginx.conf). Qualquer outro
  //    caminho sob `/f/` mostra "indisponível" — nunca cai na casca/login, que não pode ser incorporada.
  {
    path: 'f',
    children: [
      {
        path: ':chave',
        loadComponent: () =>
          import('./funcionalidades/aquisicao/formulario-publico.pagina.js').then((m) => m.FormularioPublicoPagina),
      },
      {
        path: '**',
        loadComponent: () =>
          import('./funcionalidades/aquisicao/formulario-publico.pagina.js').then((m) => m.FormularioPublicoPagina),
      },
    ],
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
      // Cadastro/edição do contato (formulário-página). ⚠️ `contato/novo` ANTES de
      // `contato/:id`, senão "novo" casa como id.
      {
        path: 'contato/novo',
        loadComponent: () =>
          import('./funcionalidades/crm/contato-form.pagina.js').then((m) => m.ContatoFormPagina),
      },
      {
        path: 'contato/:id/editar',
        loadComponent: () =>
          import('./funcionalidades/crm/contato-form.pagina.js').then((m) => m.ContatoFormPagina),
      },
      {
        path: 'contato/:id',
        loadComponent: () =>
          import('./funcionalidades/crm/ficha.pagina.js').then((m) => m.FichaContatoPagina),
      },
      // Detalhe de um pedido (R7): deep link — chega da lista de Pedidos, da
      // ficha do contato ou do chat. Reusa a tela de lista com o modal aberto.
      {
        path: 'pedido/:id',
        loadComponent: () =>
          import('./funcionalidades/pedido/pedidos.pagina.js').then((m) => m.PedidosPagina),
      },
      // Perfil mínimo do usuário (R7): nome, e-mail, empresa e presença.
      {
        path: 'perfil',
        loadComponent: () =>
          import('./nucleo/perfil.pagina.js').then((m) => m.PerfilPagina),
      },
      // ROI de um anúncio (AQ-16): detalhe, não vai no menu — chega pela lista
      // de Mídia paga.
      {
        path: 'midia/anuncio/:id',
        loadComponent: () =>
          import('./funcionalidades/aquisicao/anuncio-roi.pagina.js').then((m) => m.AnuncioRoiPagina),
      },
      // Builder do formulário: `novo` ANTES de `:id`, senão "novo" casa como id.
      {
        path: 'formularios/novo',
        loadComponent: () =>
          import('./funcionalidades/aquisicao/formulario-builder.pagina.js').then((m) => m.FormularioBuilderPagina),
      },
      {
        path: 'formularios/:id',
        loadComponent: () =>
          import('./funcionalidades/aquisicao/formulario-builder.pagina.js').then((m) => m.FormularioBuilderPagina),
      },
      // Campanhas v2 (F1b): wizard e detalhe. `nova` ANTES de `:id`, senão "nova" casa como id.
      {
        path: 'campanhas/nova',
        loadComponent: () =>
          import('./funcionalidades/campanha/campanha-wizard.pagina.js').then((m) => m.CampanhaWizardPagina),
      },
      {
        path: 'campanhas/:id/editar',
        loadComponent: () =>
          import('./funcionalidades/campanha/campanha-wizard.pagina.js').then((m) => m.CampanhaWizardPagina),
      },
      {
        path: 'campanhas/:id',
        loadComponent: () =>
          import('./funcionalidades/campanha/campanha-detalhe.pagina.js').then((m) => m.CampanhaDetalhePagina),
      },
      ...rotasFilhas,
      // Rota desconhecida volta para a base — não deixa tela órfã.
      { path: '**', redirectTo: 'contatos' },
    ],
  },
]
