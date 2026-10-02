import { Component, ChangeDetectionStrategy, inject } from '@angular/core'
import { RouterLink } from '@angular/router'
import { AuthServico, ehProducao } from './auth.servico.js'
import { PresencaServico } from './presenca.servico.js'
import { CabecalhoTelaComponente } from '../compartilhado/ui/cabecalho-tela.componente.js'
import { PainelComponente } from '../compartilhado/ui/painel.componente.js'
import { BadgeComponente } from '../compartilhado/ui/badge.componente.js'

/**
 * Meu perfil — a tela mínima que o item do menu do usuário prometia (R7).
 *
 * ⚠️ Antes, "Meu perfil" levava a Configurações Gerais: um beco disfarçado.
 * Aqui mora o que é DA PESSOA: quem ela é no token, em que empresa está e se
 * está na mesa (presença). Nada de regra de negócio; o estado de presença é
 * espelho do servidor (PresencaServico).
 */
@Component({
  selector: 'app-perfil',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, CabecalhoTelaComponente, PainelComponente, BadgeComponente],
  template: `
    <div class="pagina">
      <ui-cabecalho-tela titulo="Meu perfil" subtitulo="Quem você é neste console e se está na mesa agora." />

      <ui-painel>
        <dl class="dados">
          <div><dt class="txt-rotulo">Nome</dt><dd class="txt-corpo">{{ auth.usuario()?.nome ?? (dev ? 'Desenvolvimento local' : '—') }}</dd></div>
          <div><dt class="txt-rotulo">E-mail</dt><dd class="txt-dados">{{ auth.usuario()?.email ?? '—' }}</dd></div>
          <div><dt class="txt-rotulo">Empresa</dt>
            <dd class="txt-corpo">
              @if (auth.sessaoStaff(); as s) {
                {{ s.clienteNome }} <ui-badge tom="atencao">acesso de staff</ui-badge>
              } @else if (auth.ehStaff()) {
                Drezz <ui-badge tom="info">staff</ui-badge>
              } @else { A empresa do seu login }
            </dd>
          </div>
        </dl>
      </ui-painel>

      <ui-painel>
        <h2 class="txt-secao">Presença</h2>
        <p class="txt-corpo sub">
          Disponível: você atende e o agente só cobre fora do expediente.
          Ausente: você acompanha, o agente responde por você e ninguém espera resposta sua.
        </p>
        <label class="alternar">
          <input type="checkbox" role="switch" [checked]="!presenca.ausente()" [disabled]="presenca.mexendo()"
                 [attr.aria-checked]="!presenca.ausente()" (change)="presenca.alternar()" />
          <span>{{ presenca.ausente() ? 'Ausente — só acompanhando' : 'Disponível — na mesa' }}</span>
        </label>
      </ui-painel>

      <p class="txt-denso rodape">
        Senha, equipe e papéis ficam em <a routerLink="/config">Configurações gerais</a>.
      </p>
    </div>
  `,
  styles: `
    :host { display: block; }
    .pagina > * + * { margin-top: var(--espacamento-4); }
    .dados { display: grid; gap: var(--espacamento-3); margin: 0; }
    .dados dt { margin: 0 0 2px; }
    .dados dd { margin: 0; color: var(--texto); display: flex; align-items: center; gap: var(--espacamento-2); flex-wrap: wrap; }
    h2 { margin: 0 0 var(--espacamento-2); color: var(--texto); }
    .sub { margin: 0 0 var(--espacamento-4); color: var(--texto-secundario); max-width: 60ch; }
    .alternar { display: inline-flex; align-items: center; gap: var(--espacamento-3); cursor: pointer; color: var(--texto); }
    .alternar input { width: 18px; height: 18px; accent-color: var(--acao); }
    .rodape { color: var(--texto-suave); }
    .rodape a { color: var(--acao); }
  `,
})
export class PerfilPagina {
  readonly auth = inject(AuthServico)
  readonly presenca = inject(PresencaServico)
  readonly dev = !ehProducao()
}
