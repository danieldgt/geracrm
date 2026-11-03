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

export interface ItemMenu {
  readonly rota: string
  readonly rotulo: string
  readonly icone: string // nome de ícone Lucide (ui-icone)
  readonly status: StatusTela
  readonly onda: string
  /** Descrição do "job" da tela — vira o subtítulo, inclusive no placeholder. */
  readonly descricao: string
  /** 'rail' = não gera rota; o item abre/recolhe o chat rail (Conversas). */
  readonly acao?: 'rail'
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

export const MENU: readonly GrupoMenu[] = [
  {
    titulo: null,
    itens: [
      { rota: 'inicio', rotulo: 'Início', icone: 'house', status: 'pronto', onda: 'O1',
        descricao: 'Como o negócio está hoje, em 3 segundos: vendas, ticket, ranking, top produtos.' },
      { rota: 'mercado', rotulo: 'Visão de Mercado', icone: 'globe', status: 'pronto', onda: 'O1',
        descricao: 'Sobreposição de origens (catálogo × WhatsApp × ERP) e distribuição RFV.' },
      { rota: 'catalogo', rotulo: 'Catálogo', icone: 'package', status: 'pronto', onda: 'O1',
        descricao: 'Produtos e SKUs com grade cor × tamanho, saldo e preço.' },
      { rota: 'catalogo-produtos', rotulo: 'Cadastro de Produtos', icone: 'tag', status: 'pronto', onda: 'O4',
        descricao: 'Cadastre produtos, variações, preços e saldo à mão — convive com o que vem do ERP.' },
    ],
  },
  {
    titulo: 'Atendimento',
    itens: [
      { rota: 'conversas', rotulo: 'Conversas', icone: 'message-circle', status: 'pronto', onda: 'O1', acao: 'rail',
        descricao: 'O inbox: responder, vender e não perder a janela de 24h.' },
      { rota: 'pedido', rotulo: 'Pedido Assistido', icone: 'shopping-cart', status: 'pronto', onda: 'O1',
        descricao: 'O tira-pedido pela grade do catálogo — o pedido nasce na conversa.' },
      { rota: 'pedidos', rotulo: 'Pedidos', icone: 'receipt', status: 'pronto', onda: 'O2',
        descricao: 'Todos os pedidos: rascunho, efetivado, falhou — por estado.' },
      { rota: 'atendimento-kanban', rotulo: 'Painel de Atendimentos', icone: 'kanban', status: 'pronto', onda: 'O2',
        descricao: 'Kanban dos atendimentos por etapa — fluxo configurável por empresa. A visão do gestor.' },
      { rota: 'numeros', rotulo: 'Meus Números', icone: 'smartphone', status: 'pronto', onda: 'O0',
        descricao: 'Conectar números oficiais (Meta) e não-oficiais (PlugZapi); saúde da frota.' },
      { rota: 'templates', rotulo: 'Templates (HSM)', icone: 'file-text', status: 'pronto', onda: 'O0',
        descricao: 'Catálogo de templates aprovados na Meta — o que reabre a janela.' },
      { rota: 'campanhas', rotulo: 'Campanhas', icone: 'megaphone', status: 'pronto', onda: 'O3',
        descricao: 'Disparo em massa com ROI honesto (vendas 3/7/14 dias).' },
      { rota: 'consumo', rotulo: 'Consumo', icone: 'line-chart', status: 'pronto', onda: 'F2',
        descricao: 'Quanto custaram WhatsApp, IA e transcrição no mês' },
      { rota: 'mensagens', rotulo: 'Mensagens Enviadas', icone: 'send', status: 'pronto', onda: 'O1',
        descricao: 'Log de envios individuais e em massa.' },
      { rota: 'listas', rotulo: 'Listas', icone: 'list', status: 'pronto', onda: 'O3',
        descricao: 'Públicos de campanha, respeitando opt-out e bloqueio.' },
      { rota: 'performance', rotulo: 'Performance', icone: 'timer', status: 'pronto', onda: 'O2',
        descricao: 'SLA, tempo de primeira resposta (humana), a contra-métrica MC-05.' },
      { rota: 'canal-config', rotulo: 'Config. do Canal', icone: 'settings', status: 'pronto', onda: 'O1',
        descricao: 'Horário de atendimento, mensagem de ausência, assinatura.' },
      { rota: 'agente', rotulo: 'Agente vendedor', icone: 'bot', status: 'pronto', onda: 'O4',
        descricao: 'Vende no WhatsApp com o catálogo e as políticas da loja — sombra, assistido ou autônomo, com auditoria por turno.' },
    ],
  },
  {
    titulo: 'Vendas',
    itens: [
      { rota: 'fila-do-dia', rotulo: 'Fila do Dia', icone: 'star', status: 'pronto', onda: 'O1',
        descricao: 'Com quem falar AGORA e por quê — a predição explicável (RFV-10).' },
      { rota: 'bloqueios', rotulo: 'Opt-out / Bloqueios', icone: 'ban', status: 'pronto', onda: 'O1',
        descricao: 'Quem pediu para não receber. O envio já respeita — aqui você gerencia a lista.' },
      { rota: 'contatos', rotulo: 'Contatos', icone: 'users', status: 'pronto', onda: 'O1',
        descricao: 'A base de clientes com o RFV humanizado.' },
      { rota: 'crm', rotulo: 'CRM (Leads)', icone: 'magnet', status: 'pronto', onda: 'O1',
        descricao: 'Kanban de qualificação: Leads, Qualificados e Descartados.' },
      { rota: 'crm-avancado', rotulo: 'CRM Avançado', icone: 'trophy', status: 'pronto', onda: 'O1',
        descricao: 'Clientes por número de pedidos e segmento RFV.' },
      { rota: 'funil', rotulo: 'Funil de Vendas', icone: 'filter', status: 'pronto', onda: 'O2',
        descricao: 'Etapas e taxa de conversão.' },
      { rota: 'carteiras', rotulo: 'Vendedores e Carteiras', icone: 'briefcase', status: 'pronto', onda: 'O1',
        descricao: 'Quem é dono de qual cliente (sem sobreposição de vigência).' },
      { rota: 'tarefas', rotulo: 'Tarefas', icone: 'check-square', status: 'pronto', onda: 'O1',
        descricao: 'Agenda de follow-up: agendadas, vencidas, concluídas.' },
      { rota: 'sequencias', rotulo: 'Sequências', icone: 'repeat', status: 'pronto', onda: 'O2',
        descricao: 'Cadências automáticas de contato.' },
      { rota: 'metas', rotulo: 'Metas', icone: 'target', status: 'pronto', onda: 'O2',
        descricao: 'Objetivos por período e por vendedor.' },
      { rota: 'mapa', rotulo: 'Mapa de Clientes', icone: 'map', status: 'pronto', onda: 'O3',
        descricao: 'Distribuição geográfica da base.' },
      { rota: 'nps', rotulo: 'NPS', icone: 'bar-chart-3', status: 'pronto', onda: 'O3',
        descricao: 'Satisfação do cliente.' },
    ],
  },
  {
    titulo: 'Recompra & Retenção',
    itens: [
      { rota: 'retencao', rotulo: 'Retenção', icone: 'refresh-cw', status: 'pronto', onda: 'O2',
        descricao: 'Funil de recompra — quem está indo embora e como trazer de volta.' },
      { rota: 'fidelidade', rotulo: 'Fidelidade / Cashback', icone: 'gift', status: 'pronto', onda: 'O2',
        descricao: 'Saldo lido do ERP; a alavancagem é nossa (ADR-020).' },
      { rota: 'segmentos', rotulo: 'Segmentos RFV', icone: 'puzzle', status: 'pronto', onda: 'O2',
        descricao: 'Construtor de segmento por recência, frequência e valor.' },
    ],
  },
  {
    titulo: 'Aquisição',
    itens: [
      { rota: 'midia', rotulo: 'Mídia paga', icone: 'megaphone', status: 'pronto', onda: 'O4',
        descricao: 'Custo e leads por anúncio — quanto cada peça trouxe, e a que preço.' },
    ],
  },
  {
    titulo: 'Integrações',
    itens: [
      { rota: 'integracao', rotulo: 'ERP (Conexões)', icone: 'plug', status: 'pronto', onda: 'O0',
        descricao: 'Conectar, testar e ver as capacidades do ERP.' },
      { rota: 'sincronizacao', rotulo: 'Sincronização', icone: 'refresh-cw', status: 'construcao', onda: 'O0',
        descricao: 'Cargas, conciliação e conflitos de identidade.' },
      { rota: 'webhooks', rotulo: 'Webhooks de saída', icone: 'link', status: 'pronto', onda: 'O1',
        descricao: 'Receba nossos eventos no seu sistema — assinados, com retry.' },
    ],
  },
  {
    titulo: 'Gestão',
    itens: [
      { rota: 'bi', rotulo: 'Painéis (BI)', icone: 'line-chart', status: 'pronto', onda: 'O2',
        descricao: 'Vendas, ranking, top produtos, exportações.' },
      { rota: 'automacoes', rotulo: 'Automações', icone: 'workflow', status: 'pronto', onda: 'O2',
        descricao: 'Gatilhos e ações automáticas.' },
      { rota: 'etiquetas-origens', rotulo: 'Etiquetas e origens', icone: 'tag', status: 'pronto', onda: 'O2',
        descricao: 'Etiquetas coloridas e origens dos contatos.' },
      { rota: 'auditoria', rotulo: 'Auditoria', icone: 'search', status: 'pronto', onda: 'O1',
        descricao: 'Quem fez o quê e quando — assunção, edição e remoção de mensagens.' },
      { rota: 'config', rotulo: 'Configurações Gerais', icone: 'wrench', status: 'pronto', onda: 'O1',
        descricao: 'Empresa, usuários, papéis.' },
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

/** Achata o menu para gerar as rotas. */
export function itensDoMenu(): ItemMenu[] {
  return MENU.flatMap((g) => g.itens)
}
