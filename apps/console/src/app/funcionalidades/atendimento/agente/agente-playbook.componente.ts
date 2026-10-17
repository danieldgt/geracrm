import { Component, ChangeDetectionStrategy, input } from '@angular/core'
import { PainelComponente, EstadoComponente } from '../../../compartilhado/ui/index.js'

/**
 * PLAYBOOK COMERCIAL — STUB da raia P17 (docs/plano-port-playbook-am.md).
 *
 * Já montado pela raia P0 na página do agente; a raia P17 preenche AQUI:
 * rascunho × publicada com diff por seção, publicar com observação, restaurar e simular.
 *
 * ⚠️ Enquanto `ABA_PLAYBOOK_PRONTA` for false, a página NÃO mostra este bloco — nada
 *    muda para quem usa o console. Ao preencher, a raia liga a constante neste
 *    mesmo arquivo (com os cinco estados de tela, skill geracrm-layout-ui).
 */
export const ABA_PLAYBOOK_PRONTA: boolean = false

@Component({
  selector: 'app-agente-playbook',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PainelComponente, EstadoComponente],
  template: `
    <ui-painel><ui-estado titulo="Playbook comercial" icone="🛠️"
      descricao="Esta seção ainda está em preparação." /></ui-painel>
  `,
})
export class AgentePlaybookComponente {
  /** Número selecionado na página (as seções do tenant inteiro ignoram). */
  readonly canalId = input.required<string>()
}
