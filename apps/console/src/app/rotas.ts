import type { Type } from '@angular/core'
import type { Route, Routes } from '@angular/router'
import { ShellComponente } from './nucleo/shell.componente.js'
import { itensDoMenu, ROTAS_ANTIGAS } from './nucleo/menu.js'
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
  inicio: () =>
    import('./funcionalidades/painel/inicio.pagina.js').then((m) => m.InicioPagina),
  'fila-do-dia': () =>
    import('./funcionalidades/crm/fila-do-dia.pagina.js').then((m) => m.FilaDoDiaPagina),
  'atendimento-kanban': () =>
    import('./funcionalidades/atendimento/atendimento-kanban.pagina.js').then((m) => m.AtendimentoKanbanPagina),
  pedidos: () =>
    import('./funcionalidades/pedido/pedidos.pagina.js').then((m) => m.PedidosPagina),
  campanhas: () =>
    import('./funcionalidades/campanha/campanhas.pagina.js').then((m) => m.CampanhasPagina),
  contatos: () =>
    import('./funcionalidades/crm/clientes.pagina.js').then((m) => m.ClientesPagina),
  funil: () =>
    import('./funcionalidades/crm/funil.pagina.js').then((m) => m.FunilPagina),
  'agenda-e-tarefas/lista': () =>
    import('./funcionalidades/crm/tarefas.pagina.js').then((m) => m.TarefasPagina),
  'agenda-e-tarefas/calendario': () =>
    import('./funcionalidades/agenda/agenda.pagina.js').then((m) => m.AgendaPagina),
  'base/rfv': () =>
    import('./funcionalidades/crm/segmentos.pagina.js').then((m) => m.SegmentosPagina),
  'base/ciclo': () =>
    import('./funcionalidades/crm/retencao.pagina.js').then((m) => m.RetencaoPagina),
  'base/pedidos': () =>
    import('./funcionalidades/crm/crm-avancado.pagina.js').then((m) => m.CrmAvancadoPagina),
  'base/cashback': () =>
    import('./funcionalidades/crm/fidelidade.pagina.js').then((m) => m.FidelidadePagina),
  'base/mercado': () =>
    import('./funcionalidades/analitico/mercado.pagina.js').then((m) => m.MercadoPagina),
  'publicos/listas': () =>
    import('./funcionalidades/crm/listas.pagina.js').then((m) => m.ListasPagina),
  'publicos/optout': () =>
    import('./funcionalidades/crm/bloqueios.pagina.js').then((m) => m.BloqueiosPagina),
  catalogo: () =>
    import('./funcionalidades/catalogo/catalogo.pagina.js').then((m) => m.CatalogoPagina),
  agente: () =>
    import('./funcionalidades/atendimento/agente/agente.pagina.js').then((m) => m.AgentePagina),
  'aquisicao/midia': () =>
    import('./funcionalidades/aquisicao/midia.pagina.js').then((m) => m.MidiaPagina),
  'aquisicao/formularios': () =>
    import('./funcionalidades/aquisicao/formularios.pagina.js').then((m) => m.FormulariosPagina),
  'automacoes/regras': () =>
    import('./funcionalidades/crm/automacoes.pagina.js').then((m) => m.AutomacoesPagina),
  'automacoes/reguas': () =>
    import('./funcionalidades/crm/sequencias.pagina.js').then((m) => m.SequenciasPagina),
  'cockpit/agora': () =>
    import('./funcionalidades/gestao/cockpit.pagina.js').then((m) => m.CockpitPagina),
  'cockpit/carteira': () =>
    import('./funcionalidades/gestao/carteira-higienizacao.pagina.js').then((m) => m.CarteiraHigienizacaoPagina),
  metas: () =>
    import('./funcionalidades/crm/metas.pagina.js').then((m) => m.MetasPagina),
  relatorios: () =>
    import('./funcionalidades/analitico/relatorios.pagina.js').then((m) => m.RelatoriosPagina),
  auditoria: () =>
    import('./funcionalidades/plataforma/auditoria.pagina.js').then((m) => m.AuditoriaPagina),
  'config/empresa': () =>
    import('./funcionalidades/plataforma/config.pagina.js').then((m) => m.ConfigPagina),
  'config/usuarios': () =>
    import('./funcionalidades/acesso/usuarios.pagina.js').then((m) => m.UsuariosPagina),
  'config/filiais': () =>
    import('./funcionalidades/acesso/filiais.pagina.js').then((m) => m.FiliaisPagina),
  'config/numeros': () =>
    import('./funcionalidades/atendimento/canais.pagina.js').then((m) => m.CanaisPagina),
  'config/atendimento': () =>
    import('./funcionalidades/atendimento/canal-config.pagina.js').then((m) => m.CanalConfigPagina),
  'config/templates': () =>
    import('./funcionalidades/atendimento/templates.pagina.js').then((m) => m.TemplatesPagina),
  'config/etiquetas': () =>
    import('./funcionalidades/crm/etiquetas-origens.pagina.js').then((m) => m.EtiquetasOrigensPagina),
  'config/integracoes': () =>
    import('./funcionalidades/integracao/conexoes.pagina.js').then((m) => m.ConexoesPagina),
  'config/webhooks': () =>
    import('./funcionalidades/integracao/webhooks.pagina.js').then((m) => m.WebhooksPagina),
  'config/importar': () =>
    import('./funcionalidades/integracao/importacao.pagina.js').then((m) => m.ImportacaoPagina),
  'config/faturamento': () =>
    import('./funcionalidades/consumo/consumo.pagina.js').then((m) => m.ConsumoPagina),
  'clientes-plataforma': () =>
    import('./funcionalidades/plataforma/clientes.pagina.js').then((m) => m.ClientesPlataformaPagina),
}

const emConstrucao = () =>
  import('./compartilhado/em-construcao.pagina.js').then((m) => m.EmConstrucaoPagina)

const rotasFilhas: Routes = itensDoMenu()
  // ⚠️ Item de rail (Conversas) NÃO gera rota — o chat vive na casca como rail.
  .filter((item) => item.acao !== 'rail')
  .map((item): Route => {
    // Tela com abas: a casca das abas + uma rota filha por aba (`/<item>/<aba>`).
    if (item.abas?.length) {
      return {
        path: item.rota,
        loadComponent: () => import('./compartilhado/tela-abas.pagina.js').then((m) => m.TelaAbasPagina),
        data: { item },
        children: [
          { path: '', pathMatch: 'full', redirectTo: item.abas[0]!.rota },
          ...item.abas.map((aba): Route => {
            const real = TELAS_REAIS[`${item.rota}/${aba.rota}`]
            return real && item.status === 'pronto'
              ? { path: aba.rota, loadComponent: real }
              : { path: aba.rota, loadComponent: emConstrucao,
                  data: { rotulo: aba.rotulo, descricao: item.descricao, icone: item.icone, onda: item.onda } }
          }),
        ],
      }
    }
    const real = TELAS_REAIS[item.rota]
    if (item.status === 'pronto' && real) {
      return { path: item.rota, loadComponent: real }
    }
    return {
      path: item.rota,
      loadComponent: emConstrucao,
      // ⚠️ O placeholder lê isto — mesma descrição do menu, sem duplicar.
      data: { rotulo: item.rotulo, descricao: item.descricao, icone: item.icone, onda: item.onda },
    }
  })

/** Rotas que saíram do menu (reorganização de 2026-11-05) — redirecionam com a aba certa. */
const rotasAntigas: Routes = Object.entries(ROTAS_ANTIGAS)
  .map(([de, para]): Route => ({ path: de, pathMatch: 'full', redirectTo: para }))

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
      // Notificações (D4): a página inteira do sino — lista por cursor, filtros, marcar todas.
      {
        path: 'notificacoes',
        loadComponent: () =>
          import('./nucleo/notificacoes.pagina.js').then((m) => m.NotificacoesPagina),
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
      // Pedido assistido: saiu do menu (o primário "Novo pedido" de Pedidos leva aqui),
      // mas a rota fica — catálogo, ficha, funil e chat abrem por ela.
      {
        path: 'pedido',
        loadComponent: () =>
          import('./funcionalidades/pedido/pedido.pagina.js').then((m) => m.PedidoAssistidoPagina),
      },
      ...rotasAntigas,
      ...rotasFilhas,
      // Rota desconhecida volta para a base — não deixa tela órfã.
      { path: '**', redirectTo: 'contatos' },
    ],
  },
]
