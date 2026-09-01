import { Component, ChangeDetectionStrategy, signal, computed, inject, OnInit } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { RouterOutlet, RouterLink, RouterLinkActive, Router } from '@angular/router'
import { firstValueFrom } from 'rxjs'
import { VERSAO } from './versao.js'
import { MENU } from './menu.js'
import { SinoNotificacoesComponente } from './sino-notificacoes.componente.js'
import { MenuUsuarioComponente } from './menu-usuario.componente.js'
import { MarcaComponente } from '../compartilhado/ui/marca.componente.js'
import { ChatRailComponente } from '../funcionalidades/atendimento/chat-rail.componente.js'
import { InboxServico } from './inbox.servico.js'
import { EventosServico } from './eventos.servico.js'
import { AlertasServico } from './alertas.servico.js'
import { TemaServico } from './tema.servico.js'
import { AuthServico } from './auth.servico.js'

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
  imports: [RouterOutlet, RouterLink, RouterLinkActive, SinoNotificacoesComponente, MenuUsuarioComponente, MarcaComponente, ChatRailComponente],
  template: `
    <div class="grade">
      <aside class="lateral" [class.recolhida]="recolhida()">
        <div class="marca">
          <button class="alternar" (click)="recolhida.set(!recolhida())" aria-label="Recolher menu">☰</button>
          <a routerLink="/inicio" class="logo" aria-label="Drezz Hub — ir para o início">
            <app-marca [rotulo]="!recolhida()" />
          </a>
        </div>

        @if (!recolhida()) {
          <div class="busca">
            <span class="lupa" aria-hidden="true">⌕</span>
            <input #campo class="busca-in" type="search" [value]="filtro()"
                   (input)="filtro.set($any($event.target).value)"
                   (keydown.enter)="irAoPrimeiro()" (keydown.escape)="filtro.set('')"
                   placeholder="Buscar no menu…" aria-label="Buscar no menu" />
            @if (filtro()) { <button class="limpa" (click)="filtro.set('')" aria-label="Limpar busca">×</button> }
          </div>
        }

        <nav>
          @for (grupo of menuFiltrado(); track grupo.titulo) {
            @if (grupo.titulo && !recolhida()) { <p class="grupo">{{ grupo.titulo }}</p> }
            @for (item of grupo.itens; track item.rota) {
              @if (item.acao === 'rail') {
                <!-- Conversas: abre/recolhe o chat rail em vez de navegar. -->
                <button type="button" class="item" [class.ativo]="inbox.railAberto()"
                        [title]="item.rotulo + ' — ' + item.descricao"
                        (click)="inbox.alternarRail(); filtro.set('')">
                  <span class="icone">{{ item.icone }}</span>
                  @if (!recolhida()) {
                    <span class="rotulo">{{ item.rotulo }}</span>
                    @if (inbox.naoLidasTotal() > 0) { <span class="ponto" [title]="inbox.naoLidasTotal() + ' não lidas'"></span> }
                  }
                </button>
              } @else {
                <a [routerLink]="item.rota" routerLinkActive="ativo" class="item"
                   [title]="item.rotulo + ' — ' + item.descricao" (click)="filtro.set('')">
                  <span class="icone">{{ item.icone }}</span>
                  @if (!recolhida()) {
                    <span class="rotulo">{{ item.rotulo }}</span>
                    @if (item.status === 'construcao') { <span class="ponto" title="Em construção"></span> }
                  }
                </a>
              }
            }
          }
          @if (!recolhida() && nadaEncontrado()) {
            <p class="nada">Nada encontrado para “{{ filtro() }}”.</p>
          }
        </nav>

        <!-- ⚠️ O rodapé responde "o que está no ar?" sem abrir o painel do
             Railway. Mostra os DOIS lados porque console e API sobem separados
             (watch path por app): quando divergem, é aqui que se vê — e essa
             divergência já explicou mais de uma "mudança que não subiu". -->
        <footer class="rodape" [title]="'Console ' + versao.commit + ' · API ' + (versaoApi() ?? '—')">
          @if (recolhida()) {
            <span class="txt-dados">{{ versao.commit }}</span>
          } @else {
            <span class="txt-dados">console {{ versao.commit }}</span>
            <span class="txt-dados" [class.divergente]="divergente()">api {{ versaoApi() ?? '…' }}</span>
            @if (divergente()) { <span class="alerta-versao">versões diferentes</span> }
          }
        </footer>
      </aside>

      <!-- Chat rail: o chat é a funcionalidade principal, sempre à mão, ancorado
           À DIREITA (coluna 3, altura total). Recolhido = faixa de avatares;
           expandido empurra OU sobrepõe (escolha do usuário), com largura
           redimensionável. Estado no InboxServico, sobrevive à navegação. -->
      <app-chat-rail />

      <!-- Barra superior: ações do usuário no canto direito (padrão de app). -->
      <header class="topo">
        <span class="espaco"></span>
        <button class="tema" (click)="tema.alternar()" [attr.aria-label]="'Tema: ' + tema.tema()"
                [title]="'Tema: ' + tema.tema() + ' (clique para trocar)'">{{ iconeTema() }}</button>
        <app-sino />
        <app-menu-usuario />
      </header>

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
    /* 3 colunas: menu · (barra superior + conteúdo) · chat-rail À DIREITA. Menu e
       rail em altura total (linhas 1–2); topo e conteúdo na coluna 2. Em overlay
       o rail é position:fixed, então a coluna 3 colapsa e o conteúdo ocupa tudo. */
    .grade { display: grid; grid-template-columns: auto 1fr auto; grid-template-rows: auto 1fr; height: 100%; }
    app-chat-rail { grid-column: 3; grid-row: 1 / 3; min-width: 0; }
    /* Lateral em tom AREIA quente (estudo de identidade: surface-2), não branca —
       harmoniza com o palco creme e destaca o conteúdo elevado. */
    .lateral { grid-row: 1 / 3; width: 250px; background: var(--superficie); border-right: 1px solid var(--borda);
      overflow-y: auto; display: flex; flex-direction: column; box-shadow: 4px 0 24px rgb(31 26 22 / .04); }
    .lateral.recolhida { width: 56px; }
    .marca { display: flex; align-items: center; gap: var(--espacamento-2);
      padding: var(--espacamento-3) var(--espacamento-4); height: var(--altura-barra-topo); position: sticky; top: 0;
      background: var(--superficie); border-bottom: 1px solid var(--borda); z-index: 1; }
    .marca .logo { display: inline-flex; align-items: center; text-decoration: none; --marca-tam: 26px; --marca-fonte: 16px; }
    .marca .logo:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; border-radius: var(--raio-controle); }
    /* Barra superior — ações do usuário à direita, sem cortar dropdowns. */
    .topo { grid-column: 2; grid-row: 1; height: var(--altura-barra-topo); display: flex; align-items: center;
      gap: var(--espacamento-2); padding: 0 var(--espacamento-4);
      background: var(--superficie-elevada); border-bottom: 1px solid var(--borda); }
    .topo .espaco { flex: 1; }
    .marca .espaco { flex: 1; }
    .tema { border: none; background: transparent; color: var(--texto-secundario); font-size: 15px; cursor: pointer; padding: 4px 6px; border-radius: var(--raio-controle); }
    .tema:hover { background: var(--superficie-hover); }
    .tema:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
    .alternar { border: none; background: transparent; color: var(--texto-secundario); font-size: 16px; cursor: pointer; padding: 4px; }
    .alternar:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
    /* Busca do menu — filtra por rótulo e descrição; Enter abre o primeiro. */
    .busca { position: relative; display: flex; align-items: center; margin: var(--espacamento-3) var(--espacamento-3) var(--espacamento-1); }
    .busca .lupa { position: absolute; left: 10px; color: var(--texto-suave); font-size: 15px; pointer-events: none; }
    .busca-in { width: 100%; padding: var(--espacamento-2) var(--espacamento-6) var(--espacamento-2) 28px;
      border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo);
      color: var(--texto); font: inherit; font-size: 14px; }
    .busca-in::-webkit-search-cancel-button { display: none; }
    .busca-in:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 1px; border-color: var(--acao); }
    .limpa { position: absolute; right: 6px; border: 0; background: transparent; color: var(--texto-suave);
      font-size: 16px; cursor: pointer; padding: 0 4px; line-height: 1; }
    .limpa:hover { color: var(--erro); }
    .nada { margin: var(--espacamento-4); font-size: 13px; color: var(--texto-suave); }
    nav { padding: var(--espacamento-1) var(--espacamento-2) var(--espacamento-6); }
    .grupo { margin: var(--espacamento-4) var(--espacamento-3) var(--espacamento-1);
      font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .07em; color: var(--texto-suave); }
    /* Item em pílula arredondada com barra de acento no ativo — padrão do estudo
       de identidade. Fonte legível para quem passa o dia na tela. */
    .item { display: flex; align-items: center; gap: var(--espacamento-3);
      padding: var(--espacamento-2) var(--espacamento-3); margin: 1px var(--espacamento-1);
      color: var(--texto-secundario); text-decoration: none; font-size: 14px;
      border-radius: var(--raio-controle); }
    /* .item também é usado num <button> (Conversas → toggle do rail). */
    button.item { border: 0; background: none; font: inherit; font-size: 14px; width: calc(100% - 2 * var(--espacamento-1)); cursor: pointer; text-align: left; }
    .item:hover { background: var(--superficie-hover); color: var(--texto); }
    .item.ativo { color: var(--marca); background: var(--acao-suave); font-weight: 600; box-shadow: inset 3px 0 0 var(--acao); }
    .item:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: -2px; }
    .icone { width: 22px; font-size: 15px; text-align: center; flex: none; }
    .rotulo { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ponto { width: 6px; height: 6px; border-radius: var(--raio-completo); background: var(--atencao); flex: none; }
    .conteudo { grid-column: 2; grid-row: 2; overflow-y: auto; min-width: 0; background: var(--fundo); }
    /* ⚠️ margin-top:auto empurra para o fim da lateral sem depender de altura
       fixa — a lista de menu cresce e encolhe com o filtro.
       ⚠️ Sem crase neste bloco: styles é um template literal, e uma crase aqui
       fecha a string no meio do CSS. Mesmo tropeço que o crase-em-sql.test.ts
       da API existe para pegar. */
    .rodape { margin-top: auto; padding: var(--espacamento-2) var(--espacamento-3);
      border-top: 1px solid var(--borda); display: flex; flex-wrap: wrap; gap: 2px var(--espacamento-2);
      color: var(--texto-suave); font-size: 11px; line-height: 1.4; }
    .rodape .divergente { color: var(--atencao); }
    .rodape .alerta-versao { color: var(--atencao); flex-basis: 100%; }
    /* Responsivo: em telas estreitas a lateral vira trilho de ícones, sem
       sobrepor o conteúdo (grid mantém as colunas separadas). */
    @media (max-width: 640px) {
      .lateral { width: 60px; }
      .lateral .rotulo, .lateral .grupo { display: none; }
    }
    .alertas { position: sticky; top: 0; z-index: 5; display: flex; flex-direction: column; }
    .alerta { padding: var(--espacamento-2) var(--espacamento-4); font-size: 13px; color: var(--texto);
      background: var(--atencao-suave); border-bottom: 1px solid var(--borda); }
    .alerta.critico { background: var(--erro-suave); }
    .alerta .sinal { margin-right: var(--espacamento-1); }
  `,
})
export class ShellComponente implements OnInit {
  readonly recolhida = signal(false)
  readonly filtro = signal('')
  private readonly eventos = inject(EventosServico)
  readonly alertas = inject(AlertasServico)
  readonly tema = inject(TemaServico)
  readonly inbox = inject(InboxServico)
  private readonly auth = inject(AuthServico)
  private readonly router = inject(Router)
  private readonly http = inject(HttpClient)

  /** O commit deste bundle, gravado no build (scripts/gerar-versao.mjs). */
  readonly versao = VERSAO
  /** O commit que a API respondeu. `null` enquanto não respondeu. */
  readonly versaoApi = signal<string | null>(null)
  /**
   * ⚠️ Console e API sobem separados (watch path por app). Divergir é NORMAL
   * durante um deploy e ANORMAL depois dele — e era invisível: a pessoa via a
   * tela velha, jurava que a mudança não subiu, e ninguém tinha como conferir
   * sem abrir o painel do Railway.
   */
  readonly divergente = computed(() => {
    const api = this.versaoApi()
    // 'local' é dev; comparar aí só produziria alarme falso na máquina de quem desenvolve.
    return api !== null && api !== 'local' && this.versao.commit !== 'local' && api !== this.versao.commit
  })

  /**
   * Menu filtrado pela busca (rótulo ou descrição); grupos vazios somem.
   *
   * ⚠️ Grupos `soStaff` só aparecem para quem é staff do drezz. É higiene de
   * interface — a autorização real é o 403 da API.
   */
  readonly menuFiltrado = computed(() => {
    const visiveis = MENU.filter((g) => !g.soStaff || this.auth.ehStaff())
    const q = this.filtro().trim().toLowerCase()
    if (!q) return visiveis
    return visiveis
      .map((g) => ({ ...g, itens: g.itens.filter((i) =>
        i.rotulo.toLowerCase().includes(q) || i.descricao.toLowerCase().includes(q)) }))
      .filter((g) => g.itens.length > 0)
  })
  readonly nadaEncontrado = computed(() => this.filtro().trim().length > 0 && this.menuFiltrado().length === 0)

  /** Enter na busca abre o primeiro resultado e limpa o filtro. */
  irAoPrimeiro(): void {
    const item = this.menuFiltrado()[0]?.itens[0]
    if (!item) return
    void this.router.navigateByUrl('/' + item.rota)
    this.filtro.set('')
  }

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
    void this.carregarVersaoApi()
  }

  /**
   * ⚠️ Uma vez, na abertura — não é polling (antipadrão medido no GeraCloud). A
   * versão da API só muda com um deploy, e um deploy recarrega esta tela.
   */
  private async carregarVersaoApi(): Promise<void> {
    try {
      const r = await firstValueFrom(this.http.get<{ versao: string }>('/saude'))
      this.versaoApi.set(r.versao)
    } catch {
      // ⚠️ Silencioso de propósito: é um rótulo de rodapé. Falhar aqui não pode
      //    virar erro na tela de quem está trabalhando — fica no traço.
      this.versaoApi.set(null)
    }
  }
}
