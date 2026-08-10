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
  readonly icone: string // emoji por ora; vira ícone real depois
  readonly status: StatusTela
  readonly onda: string
  /** Descrição do "job" da tela — vira o subtítulo, inclusive no placeholder. */
  readonly descricao: string
}

export interface GrupoMenu {
  readonly titulo: string | null // null = itens de topo, sem cabeçalho de grupo
  readonly itens: readonly ItemMenu[]
}

export const MENU: readonly GrupoMenu[] = [
  {
    titulo: null,
    itens: [
      { rota: 'inicio', rotulo: 'Início', icone: '🏠', status: 'pronto', onda: 'O1',
        descricao: 'Como o negócio está hoje, em 3 segundos: vendas, ticket, ranking, top produtos.' },
      { rota: 'mercado', rotulo: 'Visão de Mercado', icone: '🌐', status: 'construcao', onda: 'O1',
        descricao: 'Sobreposição de origens (catálogo × WhatsApp × ERP) e distribuição RFV.' },
      { rota: 'catalogo', rotulo: 'Catálogo', icone: '📦', status: 'pronto', onda: 'O1',
        descricao: 'Produtos e SKUs com grade cor × tamanho, saldo e preço.' },
    ],
  },
  {
    titulo: 'Atendimento',
    itens: [
      { rota: 'conversas', rotulo: 'Conversas', icone: '💬', status: 'pronto', onda: 'O1',
        descricao: 'O inbox: responder, vender e não perder a janela de 24h.' },
      { rota: 'pedido', rotulo: 'Pedido Assistido', icone: '🛒', status: 'pronto', onda: 'O1',
        descricao: 'O tira-pedido pela grade do catálogo — o pedido nasce na conversa.' },
      { rota: 'pedidos', rotulo: 'Pedidos', icone: '🧾', status: 'pronto', onda: 'O2',
        descricao: 'Todos os pedidos: rascunho, efetivado, falhou — por estado.' },
      { rota: 'numeros', rotulo: 'Meus Números', icone: '📱', status: 'pronto', onda: 'O0',
        descricao: 'Conectar números oficiais (Meta) e não-oficiais (PlugZapi); saúde da frota.' },
      { rota: 'templates', rotulo: 'Templates (HSM)', icone: '📝', status: 'construcao', onda: 'O0',
        descricao: 'Catálogo de templates aprovados na Meta — o que reabre a janela.' },
      { rota: 'campanhas', rotulo: 'Campanhas', icone: '📣', status: 'pronto', onda: 'O3',
        descricao: 'Disparo em massa com ROI honesto (vendas 3/7/14 dias).' },
      { rota: 'mensagens', rotulo: 'Mensagens Enviadas', icone: '📤', status: 'construcao', onda: 'O1',
        descricao: 'Log de envios individuais e em massa.' },
      { rota: 'listas', rotulo: 'Listas', icone: '🗂️', status: 'construcao', onda: 'O3',
        descricao: 'Públicos de campanha, respeitando opt-out e bloqueio.' },
      { rota: 'performance', rotulo: 'Performance', icone: '⏱️', status: 'construcao', onda: 'O2',
        descricao: 'SLA, tempo de primeira resposta (humana), a contra-métrica MC-05.' },
      { rota: 'canal-config', rotulo: 'Config. do Canal', icone: '⚙️', status: 'construcao', onda: 'O1',
        descricao: 'Horário de atendimento, mensagem de ausência, assinatura.' },
    ],
  },
  {
    titulo: 'Vendas',
    itens: [
      { rota: 'fila-do-dia', rotulo: 'Fila do Dia', icone: '⭐', status: 'pronto', onda: 'O1',
        descricao: 'Com quem falar AGORA e por quê — a predição explicável (RFV-10).' },
      { rota: 'bloqueios', rotulo: 'Opt-out / Bloqueios', icone: '🚫', status: 'pronto', onda: 'O1',
        descricao: 'Quem pediu para não receber. O envio já respeita — aqui você gerencia a lista.' },
      { rota: 'contatos', rotulo: 'Contatos', icone: '👥', status: 'pronto', onda: 'O1',
        descricao: 'A base de clientes com o RFV humanizado.' },
      { rota: 'crm', rotulo: 'CRM (Leads)', icone: '🧲', status: 'construcao', onda: 'O1',
        descricao: 'Kanban de leads por etapa do funil.' },
      { rota: 'crm-avancado', rotulo: 'CRM Avançado', icone: '🏆', status: 'construcao', onda: 'O1',
        descricao: 'Clientes por número de pedidos e segmento RFV.' },
      { rota: 'funil', rotulo: 'Funil de Vendas', icone: '🫙', status: 'pronto', onda: 'O2',
        descricao: 'Etapas e taxa de conversão.' },
      { rota: 'carteiras', rotulo: 'Vendedores e Carteiras', icone: '💼', status: 'pronto', onda: 'O1',
        descricao: 'Quem é dono de qual cliente (sem sobreposição de vigência).' },
      { rota: 'tarefas', rotulo: 'Tarefas', icone: '✅', status: 'pronto', onda: 'O1',
        descricao: 'Agenda de follow-up: agendadas, vencidas, concluídas.' },
      { rota: 'sequencias', rotulo: 'Sequências', icone: '🔁', status: 'construcao', onda: 'O2',
        descricao: 'Cadências automáticas de contato.' },
      { rota: 'metas', rotulo: 'Metas', icone: '🎯', status: 'construcao', onda: 'O2',
        descricao: 'Objetivos por período e por vendedor.' },
      { rota: 'mapa', rotulo: 'Mapa de Clientes', icone: '🗺️', status: 'construcao', onda: 'O3',
        descricao: 'Distribuição geográfica da base.' },
      { rota: 'nps', rotulo: 'NPS', icone: '📊', status: 'construcao', onda: 'O3',
        descricao: 'Satisfação do cliente.' },
    ],
  },
  {
    titulo: 'Recompra & Retenção',
    itens: [
      { rota: 'retencao', rotulo: 'Retenção', icone: '🔄', status: 'construcao', onda: 'O2',
        descricao: 'Funil de recompra — quem está indo embora e como trazer de volta.' },
      { rota: 'fidelidade', rotulo: 'Fidelidade / Cashback', icone: '🎁', status: 'construcao', onda: 'O2',
        descricao: 'Saldo lido do ERP; a alavancagem é nossa (ADR-020).' },
      { rota: 'segmentos', rotulo: 'Segmentos RFV', icone: '🧩', status: 'pronto', onda: 'O2',
        descricao: 'Construtor de segmento por recência, frequência e valor.' },
    ],
  },
  {
    titulo: 'Integrações',
    itens: [
      { rota: 'integracao', rotulo: 'ERP (Conexões)', icone: '🔌', status: 'pronto', onda: 'O0',
        descricao: 'Conectar, testar e ver as capacidades do ERP.' },
      { rota: 'sincronizacao', rotulo: 'Sincronização', icone: '♻️', status: 'construcao', onda: 'O0',
        descricao: 'Cargas, conciliação e conflitos de identidade.' },
      { rota: 'webhooks', rotulo: 'Webhooks de saída', icone: '🔗', status: 'pronto', onda: 'O1',
        descricao: 'Receba nossos eventos no seu sistema — assinados, com retry.' },
    ],
  },
  {
    titulo: 'Gestão',
    itens: [
      { rota: 'bi', rotulo: 'Painéis (BI)', icone: '📈', status: 'construcao', onda: 'O2',
        descricao: 'Vendas, ranking, top produtos, exportações.' },
      { rota: 'automacoes', rotulo: 'Automações', icone: '🤖', status: 'construcao', onda: 'O2',
        descricao: 'Gatilhos e ações automáticas.' },
      { rota: 'auditoria', rotulo: 'Auditoria', icone: '🔎', status: 'pronto', onda: 'O1',
        descricao: 'Quem fez o quê e quando — assunção, edição e remoção de mensagens.' },
      { rota: 'config', rotulo: 'Configurações Gerais', icone: '🔧', status: 'construcao', onda: 'O1',
        descricao: 'Empresa, usuários, papéis.' },
    ],
  },
]

/** Achata o menu para gerar as rotas. */
export function itensDoMenu(): ItemMenu[] {
  return MENU.flatMap((g) => g.itens)
}
