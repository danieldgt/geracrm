import { Component, ChangeDetectionStrategy, input } from '@angular/core'
import { PainelComponente, EstadoComponente } from '../../../compartilhado/ui/index.js'

/**
 * MENSAGENS ATIVAS — STUB da raia P11 (docs/plano-port-playbook-am.md).
 *
 * Já montado pela raia P0 na página do agente; a raia P11 preenche AQUI:
 * limites por dia/semana, template de retorno fora de 24h e a suspensão por qualidade do número.
 *
 * ⚠️ Enquanto `ATIVAS_PRONTO` for false, a página NÃO mostra este bloco — nada
 *    muda para quem usa o console. Ao preencher, a raia liga a constante neste
 *    mesmo arquivo (com os cinco estados de tela, skill geracrm-layout-ui).
 */
export const ATIVAS_PRONTO: boolean = false

@Component({
  selector: 'app-agente-ativas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PainelComponente, EstadoComponente],
  template: `
    <ui-painel><ui-estado titulo="Mensagens ativas" icone="🛠️"
      descricao="Esta seção ainda está em preparação." /></ui-painel>
  `,
})
export class AgenteAtivasComponente {
  /** Número selecionado na página (as seções do tenant inteiro ignoram). */
  readonly canalId = input.required<string>()
}
