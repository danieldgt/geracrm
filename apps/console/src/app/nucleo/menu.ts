/**
 * A fonte ÚNICA da navegação — o menu inteiro como dado.
 *
 * ⚠️ É daqui que o shell desenha o menu E que as rotas são geradas. Uma só
 * lista: um item novo aparece no menu e vira rota no mesmo lugar, sem divergir.
 * Espelha `docs/mapa-de-telas.md` — mudou lá, muda aqui.
 *
 * `status`: 'pronto' (tela real) · 'construcao' (roteada, placeholder honesto).
 * A tela em construção NÃO some do menu — o sistema mostra o que VAI ter, com
 * consistência, e diz claramente o que ainda não existe.
 */

export type StatusTela = 'pronto' | 'construcao'

/**
 * Aba de uma tela com abas (`TelaAbasPagina`). A rota da aba é `/<item>/<aba>` e
 * a tela que ela carrega fica em `TELAS_REAIS['<item>/<aba>']` (rotas.ts).
 */
export interface AbaMenu {
  readonly rota: string
  readonly rotulo: string
  readonly modulo?: 'agenda'
  readonly soGestao?: boolean
}

export interface ItemMenu {
  readonly rota: string
  readonly rotulo: string
  readonly icone: string // nome de ícone Lucide (ui-icone)
  readonly status: StatusTela
  readonly onda: string
  /** O "job" da tela, em uma frase do lado de quem usa — vira o subtítulo. Sem código de requisito. */
  readonly descricao: string
  /** 'rail' = não gera rota; o item abre/recolhe o chat rail (Conversas). */
  readonly acao?: 'rail'
  /** Item de módulo opcional por tenant: some do menu quando o módulo está desligado (ModulosServico). */
  readonly modulo?: 'agenda'
  /** Só aparece para a gestão (gestor/supervisor/admin) — higiene de interface; a API responde 403. */
  readonly soGestao?: boolean
  /**
   * Tela com abas: telas irmãs que respondem à mesma pergunta viram abas de UMA
   * entrada do menu (docs/plano-reorganizacao-console.md). A primeira aba é o padrão.
   */
  readonly abas?: readonly AbaMenu[]
}

export interface GrupoMenu {
  readonly titulo: string | null // null = itens de topo, sem cabeçalho de grupo
  readonly itens: readonly ItemMenu[]
  /**
   * Grupo do STAFF do drezz — some do menu para quem é cliente.
   *
   * ⚠️ Isto é higiene de interface, não segurança: a rota continua existindo e
   * quem autoriza é a API (403 pelo guard `exigirStaff`). Esconder aqui só evita
   * mostrar porta que não abre.
   */
  readonly soStaff?: boolean
}

/**
 * O menu: uma entrada por TAREFA, não por recurso do backend. Reorganizado em
 * 2026-11-05 (docs/plano-reorganizacao-console.md): de 50 entradas para 21, com
 * as telas irmãs como abas. Rota antiga não quebra: ver `ROTAS_ANTIGAS`.
 */
export const MENU: readonly GrupoMenu[] = [
  {
    titulo: null,
    itens: [
      { rota: 'inicio', rotulo: 'Início', icone: 'house', status: 'pronto', onda: 'O1',
        descricao: 'Como o negócio está no período: vendas, tarefas e quem precisa de atenção.' },
      { rota: 'conversas', rotulo: 'Conversas', icone: 'message-circle', status: 'pronto', onda: 'O1', acao: 'rail',
        descricao: 'O inbox: responder, vender e não perder a janela de 24h.' },
    ],
  },
  {
    titulo: 'Atendimento',
    itens: [
      { rota: 'fila-do-dia', rotulo: 'Fila do Dia', icone: 'star', status: 'pronto', onda: 'O1',
        descricao: 'Com quem falar agora e por quê.' },
      { rota: 'atendimento-kanban', rotulo: 'Painel de Atendimentos', icone: 'kanban', status: 'pronto', onda: 'O2',
        descricao: 'Os atendimentos por etapa — o fluxo é configurável por empresa.' },
      { rota: 'pedidos', rotulo: 'Pedidos', icone: 'receipt', status: 'pronto', onda: 'O2',
        descricao: 'Rascunhos, aguardando confirmação, efetivados e os que falharam no ERP.' },
      { rota: 'campanhas', rotulo: 'Campanhas', icone: 'megaphone', status: 'pronto', onda: 'O3',
        descricao: 'Disparo em massa com o retorno medido em vendas de 3, 7 e 14 dias.' },
    ],
  },
  {
    titulo: 'Vendas',
    itens: [
      { rota: 'contatos', rotulo: 'Contatos', icone: 'users', status: 'pronto', onda: 'O1',
        descricao: 'Todos os contatos, dos que mais compram aos que ainda não compraram.' },
      { rota: 'funil', rotulo: 'Funil', icone: 'filter', status: 'pronto', onda: 'O2',
        descricao: 'Oportunidades por etapa, a qualificação dos leads e o panorama por vendedor.' },
      { rota: 'agenda-e-tarefas', rotulo: 'Agenda e tarefas', icone: 'check-square', status: 'pronto', onda: 'O1',
        descricao: 'Follow-ups e compromissos com clientes.',
        abas: [
          { rota: 'lista', rotulo: 'Tarefas' },
          { rota: 'calendario', rotulo: 'Calendário', modulo: 'agenda' },
        ] },
      { rota: 'base', rotulo: 'Base de clientes', icone: 'puzzle', status: 'pronto', onda: 'O2',
        descricao: 'Onde cada cliente está no ciclo de recompra — e quantos dá para alcançar.',
        abas: [
          { rota: 'rfv', rotulo: 'Segmentos RFV' },
          { rota: 'ciclo', rotulo: 'Ciclo de recompra' },
          { rota: 'pedidos', rotulo: 'Por nº de pedidos' },
          { rota: 'cashback', rotulo: 'Cashback' },
          { rota: 'mercado', rotulo: 'Alcance' },
        ] },
      { rota: 'publicos', rotulo: 'Públicos', icone: 'list', status: 'pronto', onda: 'O3',
        descricao: 'Listas de envio e quem pediu para não receber.',
        abas: [
          { rota: 'listas', rotulo: 'Listas' },
          { rota: 'optout', rotulo: 'Opt-out e bloqueios' },
        ] },
    ],
  },
  {
    titulo: 'Catálogo e IA',
    itens: [
      { rota: 'catalogo', rotulo: 'Catálogo', icone: 'package', status: 'pronto', onda: 'O1',
        descricao: 'Produtos com grade cor × tamanho, saldo e preço — do ERP e cadastrados à mão.' },
      { rota: 'agente', rotulo: 'Agente vendedor', icone: 'bot', status: 'pronto', onda: 'O4',
        descricao: 'Vende no WhatsApp com o catálogo e as políticas da loja — com auditoria por turno.' },
    ],
  },
  {
    titulo: 'Crescimento',
    itens: [
      { rota: 'aquisicao', rotulo: 'Aquisição', icone: 'magnet', status: 'pronto', onda: 'O4',
        descricao: 'De onde vêm os leads: anúncios pagos e formulários públicos.',
        abas: [
          { rota: 'midia', rotulo: 'Mídia paga' },
          { rota: 'formularios', rotulo: 'Formulários' },
        ] },
      { rota: 'automacoes', rotulo: 'Automações', icone: 'workflow', status: 'pronto', onda: 'O2',
        descricao: 'Regras que agem sozinhas e réguas de contato em passos.',
        abas: [
          { rota: 'regras', rotulo: 'Regras' },
          { rota: 'reguas', rotulo: 'Réguas de contato' },
        ] },
    ],
  },
  {
    titulo: 'Gestão',
    itens: [
      { rota: 'cockpit', rotulo: 'Cockpit', icone: 'bar-chart-3', status: 'pronto', onda: 'D1', soGestao: true,
        descricao: 'SLA, esquecidos e quem está sem próximo passo — agora.',
        abas: [
          { rota: 'agora', rotulo: 'Agora' },
          { rota: 'carteira', rotulo: 'Higienização da carteira' },
        ] },
      { rota: 'metas', rotulo: 'Metas', icone: 'target', status: 'pronto', onda: 'O2',
        descricao: 'Objetivos por período e por vendedor.' },
      { rota: 'relatorios', rotulo: 'Relatórios', icone: 'line-chart', status: 'pronto', onda: 'E1',
        descricao: 'Vendas, contatos, atendimento e WhatsApp — com período livre e CSV.' },
      { rota: 'auditoria', rotulo: 'Auditoria', icone: 'search', status: 'pronto', onda: 'O1',
        descricao: 'Quem fez o quê e quando.' },
    ],
  },
  {
    titulo: null,
    itens: [
      { rota: 'config', rotulo: 'Configurações', icone: 'settings', status: 'pronto', onda: 'O1',
        descricao: 'Empresa, equipe, números, integrações e faturamento.',
        abas: [
          { rota: 'empresa', rotulo: 'Empresa' },
          { rota: 'usuarios', rotulo: 'Usuários' },
          { rota: 'filiais', rotulo: 'Filiais' },
          { rota: 'numeros', rotulo: 'Números' },
          { rota: 'atendimento', rotulo: 'Atendimento' },
          { rota: 'templates', rotulo: 'Templates' },
          { rota: 'etiquetas', rotulo: 'Etiquetas e origens' },
          { rota: 'integracoes', rotulo: 'ERP' },
          { rota: 'webhooks', rotulo: 'Webhooks' },
          { rota: 'importar', rotulo: 'Importar', soGestao: true },
          { rota: 'faturamento', rotulo: 'Consumo' },
        ] },
    ],
  },
  {
    titulo: 'Plataforma',
    soStaff: true,
    itens: [
      { rota: 'clientes-plataforma', rotulo: 'Clientes', icone: 'building-2', status: 'pronto', onda: 'O2',
        descricao: 'Cadastrar e acompanhar as empresas que usam o sistema.' },
    ],
  },
]

/**
 * Rotas que saíram do menu na reorganização de 2026-11-05 → onde a tela mora agora.
 *
 * ⚠️ Nada quebra: favorito, link de notificação e `routerLink` antigo caem no
 * destino certo (aba incluída). Destino com `?` leva a aba interna da tela.
 * Testado em `menu-reorganizacao.spec.ts` (todo destino existe no menu).
 */
export const ROTAS_ANTIGAS: Readonly<Record<string, string>> = {
  bi: '/relatorios?relatorio=vendas',
  mapa: '/relatorios?relatorio=contatos&dim=uf',
  performance: '/relatorios?relatorio=atendimento',
  nps: '/relatorios?relatorio=atendimento',
  mensagens: '/relatorios?relatorio=enviadas',
  mercado: '/base/mercado',
  segmentos: '/base/rfv',
  retencao: '/base/ciclo',
  'crm-avancado': '/base/pedidos',
  fidelidade: '/base/cashback',
  crm: '/funil?aba=qualificacao',
  listas: '/publicos/listas',
  bloqueios: '/publicos/optout',
  tarefas: '/agenda-e-tarefas/lista',
  agenda: '/agenda-e-tarefas/calendario',
  sequencias: '/automacoes/reguas',
  midia: '/aquisicao/midia',
  formularios: '/aquisicao/formularios',
  'carteira-higienizacao': '/cockpit/carteira',
  'catalogo-produtos': '/catalogo',
  'canal-config': '/config/atendimento',
  numeros: '/config/numeros',
  usuarios: '/config/usuarios',
  filiais: '/config/filiais',
  templates: '/config/templates',
  'etiquetas-origens': '/config/etiquetas',
  integracao: '/config/integracoes',
  sincronizacao: '/config/integracoes',
  webhooks: '/config/webhooks',
  importar: '/config/importar',
  consumo: '/config/faturamento',
}

/** Achata o menu para gerar as rotas. */
export function itensDoMenu(): ItemMenu[] {
  return MENU.flatMap((g) => g.itens)
}

/**
 * Esconde do menu os itens de módulo desligado (e os grupos que ficam vazios).
 * ⚠️ Higiene de interface: a rota continua existindo (mostra "módulo desligado") e a API responde 404.
 */
export function menuVisivel(
  menu: readonly GrupoMenu[], modulosAtivos: Readonly<Partial<Record<NonNullable<ItemMenu['modulo']>, boolean>>>,
  gestao = false,
): readonly GrupoMenu[] {
  return menu
    .map((g) => ({ ...g, itens: g.itens.filter((i) => visivel(i, modulosAtivos, gestao)) }))
    .filter((g) => g.itens.length > 0)
}

/** As abas que a pessoa vê numa tela com abas (mesma regra de módulo e de gestão do menu). */
export function abasVisiveis(
  item: Pick<ItemMenu, 'abas'>, modulosAtivos: Readonly<Partial<Record<NonNullable<ItemMenu['modulo']>, boolean>>>,
  gestao = false,
): readonly AbaMenu[] {
  return (item.abas ?? []).filter((a) => visivel(a, modulosAtivos, gestao))
}

function visivel(
  i: { readonly modulo?: 'agenda'; readonly soGestao?: boolean },
  modulosAtivos: Readonly<Partial<Record<'agenda', boolean>>>, gestao: boolean,
): boolean {
  return (!i.modulo || modulosAtivos[i.modulo] === true) && (!i.soGestao || gestao)
}
