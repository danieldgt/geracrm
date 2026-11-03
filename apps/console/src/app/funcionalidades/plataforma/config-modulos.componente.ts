import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core'
import { ConfirmacaoServico, PainelComponente, ToastServico } from '../../compartilhado/ui/index.js'
import { ModulosServico, type ModuloId } from '../../nucleo/modulos.servico.js'
import { mensagemFalhaAoSalvar } from './config.regras.js'

/**
 * Painel MÓDULOS (D5): chaves de módulos opcionais, padrão DESLIGADO.
 * Ligar e desligar pedem confirmação (muda menu e ficha de todo mundo) e só valem
 * depois que a API confirma — o estado vem do `ModulosServico` (espelho do servidor).
 */
@Component({
  selector: 'app-config-modulos',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PainelComponente],
  template: `
    <ui-painel>
      <h2 class="txt-secao">Módulos</h2>
      <p class="dica txt-corpo">Recursos opcionais. Desligados, não aparecem para ninguém da empresa.</p>
      <div class="modulo">
        <div class="texto">
          <span class="nome txt-corpo">Agenda</span>
          <span class="desc txt-denso">Agenda — calendário de reuniões, visitas e ligações; quando ligado, aparece no menu e na ficha.</span>
          @if (leitura()) { <span class="desc txt-denso">Somente administradores ligam ou desligam.</span> }
        </div>
        <label class="chave">
          <input type="checkbox" role="switch" [checked]="modulos.agendaAtiva()" [disabled]="leitura() || mexendo()"
                 [attr.aria-label]="'Agenda ' + (modulos.agendaAtiva() ? 'ligada' : 'desligada')"
                 (change)="alternar('agenda', $any($event.target))" />
          <span class="estado txt-denso">{{ modulos.agendaAtiva() ? 'Ligado' : 'Desligado' }}</span>
        </label>
      </div>
    </ui-painel>
  `,
  styles: `
    :host { display: block; margin-bottom: var(--espacamento-4); }
    h2 { margin: 0 0 var(--espacamento-1); }
    .dica { margin: 0 0 var(--espacamento-4); color: var(--texto-secundario); }
    .modulo { display: flex; align-items: center; justify-content: space-between; gap: var(--espacamento-4); flex-wrap: wrap; }
    .texto { display: flex; flex-direction: column; gap: var(--espacamento-1); min-width: 0; flex: 1 1 280px; }
    .nome { color: var(--texto); font-weight: 600; }
    .desc { color: var(--texto-secundario); }
    .chave { display: inline-flex; align-items: center; gap: var(--espacamento-2); min-height: var(--densidade-alvo-clique-console); }
    .estado { color: var(--texto-secundario); }
  `,
})
export class ConfigModulosComponente {
  readonly modulos = inject(ModulosServico)
  private readonly confirmacao = inject(ConfirmacaoServico)
  private readonly toast = inject(ToastServico)

  readonly leitura = input(true)
  readonly mexendo = signal(false)

  async alternar(modulo: ModuloId, caixa: HTMLInputElement): Promise<void> {
    const ligar = caixa.checked
    // ⚠️ A caixa já mudou no DOM; sem confirmação ou com falha, volta ao que o servidor tem.
    const ok = await this.confirmacao.confirmar({
      titulo: ligar ? 'Ligar a Agenda?' : 'Desligar a Agenda?',
      mensagem: ligar
        ? 'A Agenda passa a aparecer no menu e na ficha de todos da empresa.'
        : 'A Agenda some do menu e da ficha de todos. Os compromissos já criados não são apagados.',
      acao: ligar ? 'Ligar' : 'Desligar',
    })
    if (!ok) { caixa.checked = !ligar; return }
    this.mexendo.set(true)
    try {
      await this.modulos.definir(modulo, ligar)
      this.toast.sucesso(ligar ? 'Agenda ligada.' : 'Agenda desligada.')
    } catch (e) {
      caixa.checked = !ligar
      this.toast.erro(mensagemFalhaAoSalvar(e))
    } finally { this.mexendo.set(false) }
  }
}
