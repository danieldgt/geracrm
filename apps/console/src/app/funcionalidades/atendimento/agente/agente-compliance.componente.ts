import { Component, ChangeDetectionStrategy, input } from '@angular/core'
import { PainelComponente, EstadoComponente } from '../../../compartilhado/ui/index.js'

/**
 * FRASES PROIBIDAS E GATILHOS DE TRANSFERÊNCIA — STUB da raia P2 (docs/plano-port-playbook-am.md).
 *
 * Já montado pela raia P0 na página do agente; a raia P2 preenche AQUI:
 * frases proibidas e gatilhos de handoff do número (só acrescentam à base), via GET/PUT /v1/canais/:id/agente/compliance; serviço próprio em compliance.servico.ts.
 *
 * ⚠️ Enquanto `COMPLIANCE_PRONTO` for false, a página NÃO mostra este bloco — nada
 *    muda para quem usa o console. Ao preencher, a raia liga a constante neste
 *    mesmo arquivo (com os cinco estados de tela, skill geracrm-layout-ui).
 */
export const COMPLIANCE_PRONTO: boolean = false

@Component({
  selector: 'app-agente-compliance',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PainelComponente, EstadoComponente],
  template: `
    <ui-painel><ui-estado titulo="Frases proibidas e gatilhos de transferência" icone="🛠️"
      descricao="Esta seção ainda está em preparação." /></ui-painel>
  `,
})
export class AgenteComplianceComponente {
  /** Número selecionado na página (as seções do tenant inteiro ignoram). */
  readonly canalId = input.required<string>()
}
