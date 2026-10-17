import { Component, ChangeDetectionStrategy, input } from '@angular/core'
import { AgenteComplianceComponente, COMPLIANCE_PRONTO } from './agente-compliance.componente.js'
import { AgenteCustoComponente, CUSTO_PRONTO } from './agente-custo.componente.js'
import { AgenteAtivasComponente, ATIVAS_PRONTO } from './agente-ativas.componente.js'

/**
 * ABA "PROTEÇÕES" — o que só ACRESCENTA restrição ao agente (ADR-029: a tela
 * nunca desliga um guardrail). Montada pela raia P0; cada bloco é de uma raia:
 * compliance (P2), custo e tetos (P6), mensagens ativas (P11).
 *
 * A aba só aparece quando ao menos um bloco está pronto, e cada bloco só
 * aparece quando a sua raia o liga (constante no próprio arquivo do bloco).
 */
export const ABA_PROTECOES_PRONTA = COMPLIANCE_PRONTO || CUSTO_PRONTO || ATIVAS_PRONTO

@Component({
  selector: 'app-agente-protecoes',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AgenteComplianceComponente, AgenteCustoComponente, AgenteAtivasComponente],
  template: `
    <div class="blocos">
      @if (compliance) { <app-agente-compliance [canalId]="canalId()" /> }
      @if (custo) { <app-agente-custo [canalId]="canalId()" /> }
      @if (ativas) { <app-agente-ativas [canalId]="canalId()" /> }
    </div>
  `,
  styles: `
    :host { min-width: 0; }
    .blocos { display: grid; gap: var(--espacamento-4); min-width: 0; }
  `,
})
export class AgenteProtecoesComponente {
  readonly canalId = input.required<string>()
  readonly compliance = COMPLIANCE_PRONTO
  readonly custo = CUSTO_PRONTO
  readonly ativas = ATIVAS_PRONTO
}
