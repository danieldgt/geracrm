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
  campanhas: () =>
    import('./funcionalidades/campanha/campanhas.pagina.js').then((m) => m.CampanhasPagina),
  pedidos: () =>
    import('./funcionalidades/pedido/pedidos.pagina.js').then((m) => m.PedidosPagina),
  catalogo: () =>
    import('./funcionalidades/catalogo/catalogo.pagina.js').then((m) => m.CatalogoPagina),
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
}

const rotasFilhas = itensDoMenu().map((item) => {
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
      // Ficha do contato: rota de detalhe (não vai no menu). `id` liga ao input
      // do componente via withComponentInputBinding.
      {
        path: 'contato/:id',
        loadComponent: () =>
          import('./funcionalidades/crm/ficha.pagina.js').then((m) => m.FichaContatoPagina),
      },
      ...rotasFilhas,
      // Rota desconhecida volta para a base — não deixa tela órfã.
      { path: '**', redirectTo: 'contatos' },
    ],
  },
]
