import { Component, ChangeDetectionStrategy, signal, inject, OnInit } from '@angular/core'
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router'
import { MENU } from './menu.js'
import { SinoNotificacoesComponente } from './sino-notificacoes.componente.js'
import { EventosServico } from './eventos.servico.js'
import { AlertasServico } from './alertas.servico.js'
import { TemaServico } from './tema.servico.js'

/**
 * A casca do console — topo + menu lateral + área de conteúdo.
 *
 * ⚠️ Componente ÚNICO da navegação, para 40+ telas não virarem 40 layouts. O
 * menu é desenhado a partir do config (`menu.ts`), a mesma fonte que gera as
 * rotas — item novo aparece aqui automaticamente.
 *
 * Densidade > animação (8h na mesma tela): menu compacto, item ativo destacado,
 * grupos com cabeçalho discreto. O selo "construção" aparece no próprio item
 * para o gestor saber o que já existe sem clicar.
 */
@Component({
  selector: 'app-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, SinoNotificacoesComponente],
  template: `
    <div class="grade">
      <aside class="lateral" [class.recolhida]="recolhida()">
        <div class="marca">
          <button class="alternar" (click)="recolhida.set(!recolhida())" aria-label="Recolher menu">☰</button>
          @if (!recolhida()) { <strong>GeraCRM</strong> }
          <span class="espaco"></span>
          <button class="tema" (click)="tema.alternar()" [attr.aria-label]="'Tema: ' + tema.tema()"
                  [title]="'Tema: ' + tema.tema() + ' (clique para trocar)'">{{ iconeTema() }}</button>
          <app-sino />
        </div>

        <nav>
          @for (grupo of menu; track grupo.titulo) {
            @if (grupo.titulo && !recolhida()) { <p class="grupo">{{ grupo.titulo }}</p> }
            @for (item of grupo.itens; track item.rota) {
              <a [routerLink]="item.rota" routerLinkActive="ativo" class="item"
                 [title]="item.rotulo + ' — ' + item.descricao">
                <span class="icone">{{ item.icone }}</span>
                @if (!recolhida()) {
                  <span class="rotulo">{{ item.rotulo }}</span>
                  @if (item.status === 'construcao') { <span class="ponto" title="Em construção"></span> }
                }
              </a>
            }
          }
        </nav>
      </aside>

      <div class="conteudo">
        <!-- Alertas técnicos abertos (I-10): faixa visível, ação nomeada. -->
        @if (alertas.abertos().length) {
          <div class="alertas" role="alert">
            @for (a of alertas.abertos(); track a.id) {
              <div class="alerta" [class.critico]="a.severidade === 'critico'">
                <span class="sinal">⚠️</span> {{ a.mensagem }}
              </div>
            }
          </div>
        }
        <router-outlet />
      </div>
    </div>
  `,
  styles: `
    :host { display: block; height: 100vh; }
    .grade { display: grid; grid-template-columns: auto 1fr; height: 100%; }
    .lateral { width: 236px; background: var(--superficie-elevada); border-right: 1px solid var(--borda);
      overflow-y: auto; display: flex; flex-direction: column; }
    .lateral.recolhida { width: 56px; }
    .marca { display: flex; align-items: center; gap: var(--espacamento-2);
      padding: var(--espacamento-3) var(--espacamento-4); position: sticky; top: 0;
      background: var(--superficie-elevada); border-bottom: 1px solid var(--borda); z-index: 1; }
    .marca strong { color: var(--marca); font-size: 15px; }
    .marca .espaco { flex: 1; }
    .tema { border: none; background: transparent; color: var(--texto-secundario); font-size: 15px; cursor: pointer; padding: 4px 6px; border-radius: var(--raio-controle); }
    .tema:hover { background: var(--superficie-hover); }
    .tema:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
    .alternar { border: none; background: transparent; color: var(--texto-secundario); font-size: 16px; cursor: pointer; padding: 4px; }
    .alternar:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
    nav { padding: var(--espacamento-2) 0 var(--espacamento-6); }
    .grupo { margin: var(--espacamento-4) var(--espacamento-4) var(--espacamento-1);
      font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--texto-suave); }
    .item { display: flex; align-items: center; gap: var(--espacamento-3);
      padding: var(--espacamento-2) var(--espacamento-4); color: var(--texto-secundario);
      text-decoration: none; font-size: 13px; border-left: 2px solid transparent; }
    .item:hover { background: var(--superficie-hover); color: var(--texto); }
    .item.ativo { color: var(--acao); background: var(--superficie-selecionada); border-left-color: var(--acao); }
    .item:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: -2px; }
    .icone { width: 18px; text-align: center; flex: none; }
    .rotulo { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ponto { width: 6px; height: 6px; border-radius: var(--raio-completo); background: var(--atencao); flex: none; }
    .conteudo { overflow-y: auto; min-width: 0; background: var(--fundo); }
    /* Responsivo: em telas estreitas a lateral vira trilho de ícones, sem
       sobrepor o conteúdo (grid mantém as colunas separadas). */
    @media (max-width: 640px) {
      .lateral { width: 60px; }
      .lateral .rotulo, .lateral .grupo, .marca strong { display: none; }
    }
    .alertas { position: sticky; top: 0; z-index: 5; display: flex; flex-direction: column; }
    .alerta { padding: var(--espacamento-2) var(--espacamento-4); font-size: 13px; color: var(--texto);
      background: var(--atencao-suave); border-bottom: 1px solid var(--borda); }
    .alerta.critico { background: var(--erro-suave); }
    .alerta .sinal { margin-right: var(--espacamento-1); }
  `,
})
export class ShellComponente implements OnInit {
  readonly menu = MENU
  readonly recolhida = signal(false)
  private readonly eventos = inject(EventosServico)
  readonly alertas = inject(AlertasServico)
  readonly tema = inject(TemaServico)

  iconeTema(): string {
    return this.tema.tema() === 'claro' ? '☀️' : this.tema.tema() === 'escuro' ? '🌙' : '🖥️'
  }

  /**
   * ⚠️ A casca é dona da conexão de tempo real: fica montada a vida toda da
   * sessão, então o SSE (e o sino) sobrevive à navegação entre telas. As telas
   * só ESCUTAM; nenhuma desconecta ao sair (senão derrubaria o sino).
   */
  ngOnInit(): void {
    this.tema.aplicar()
    this.eventos.conectar()
    void this.alertas.carregar()
    // Alerta novo chega pelo SSE → rebusca os abertos (sem polling).
    this.eventos.escutar('alerta.novo', () => void this.alertas.carregar())
  }
}
