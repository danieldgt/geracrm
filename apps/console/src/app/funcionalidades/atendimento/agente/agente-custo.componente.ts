import { Component, ChangeDetectionStrategy, input } from '@angular/core'
import { PainelComponente, EstadoComponente } from '../../../compartilhado/ui/index.js'

/**
 * CUSTO E TETOS — STUB da raia P6 (docs/plano-port-playbook-am.md).
 *
 * Já montado pela raia P0 na página do agente; a raia P6 preenche AQUI:
 * teto por conversa do número e orçamento mensal do tenant (alertas 80/100%), via /v1/canais/:id/agente/custo e /v1/agente/orcamento.
 *
 * ⚠️ Enquanto `CUSTO_PRONTO` for false, a página NÃO mostra este bloco — nada
 *    muda para quem usa o console. Ao preencher, a raia liga a constante neste
 *    mesmo arquivo (com os cinco estados de tela, skill geracrm-layout-ui).
 */
export const CUSTO_PRONTO: boolean = false

@Component({
  selector: 'app-agente-custo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PainelComponente, EstadoComponente],
  template: `
    <ui-painel><ui-estado titulo="Custo e tetos" icone="🛠️"
      descricao="Esta seção ainda está em preparação." /></ui-painel>
  `,
})
export class AgenteCustoComponente {
  /** Número selecionado na página (as seções do tenant inteiro ignoram). */
  readonly canalId = input.required<string>()
}
