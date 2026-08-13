import { Component, ChangeDetectionStrategy, inject, OnDestroy, computed, signal } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { RouterLink } from '@angular/router'
import { formatarProtocolo, parsearProtocolo } from '@geracrm/shared'
import { InboxServico, type ItemConversa, type Mensagem, type Thread } from '../../nucleo/inbox.servico.js'
import { EventosServico } from '../../nucleo/eventos.servico.js'
import { CanalSimboloComponente } from '../../compartilhado/ui/canal-simbolo.componente.js'

/**
 * Inbox — visual inspirado no WhatsApp (tema escuro, bolhas, avatares).
 *
 * ⚠️ A vendedora fica 8h nesta tela: densidade e estabilidade acima de enfeite.
 * Tempo real (ADR-007) atualiza lista e thread SEM refresh. A janela de 24h é
 * domínio (calcularJanela na API), não flag — e o composer troca de modo por ela.
 */
@Component({
  selector: 'app-inbox',
  imports: [FormsModule, RouterLink, CanalSimboloComponente],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wa" [class.tem-conversa]="servico.selecionadaId()">
      <!-- ───────── Lista ───────── -->
      <aside class="lista">
        <header class="barra">
          <span class="titulo">Conversas</span>
          @if (rotuloConexao()) {
            <span class="conexao" [attr.data-estado]="eventos.estado()">{{ rotuloConexao() }}</span>
          }
        </header>

        <div class="busca-wrap">
          <span class="lupa">🔍</span>
          <input class="busca" type="search" placeholder="Pesquisar conversa"
                 [ngModel]="busca()" (ngModelChange)="busca.set($event)" />
        </div>

        <div class="abas">
          <button [class.ativa]="servico.filtro() === 'todas'" (click)="servico.trocarFiltro('todas')">Todas</button>
          <button [class.ativa]="servico.filtro() === 'fila'" (click)="servico.trocarFiltro('fila')">
            Fila @if (servico.contadores().fila) { <span class="cont">{{ servico.contadores().fila }}</span> }
          </button>
          <button [class.ativa]="servico.filtro() === 'meus'" (click)="servico.trocarFiltro('meus')">
            Meus @if (servico.contadores().meus) { <span class="cont">{{ servico.contadores().meus }}</span> }
          </button>
        </div>

        <div class="itens">
          @switch (servico.estado()) {
            @case ('carregando') {
              @for (i of [1,2,3,4,5,6,7]; track i) { <div class="item esqueleto"></div> }
            }
            @case ('sem_permissao') { <p class="aviso">Você não tem acesso às conversas.</p> }
            @case ('erro') {
              <div class="aviso"><p>{{ servico.erro() }}</p>
                <button (click)="servico.carregar()">Tentar de novo</button></div>
            }
            @case ('pronto') {
              @if (protocoloBusca()) {
                <button class="item proto-busca" (click)="servico.abrirPorProtocolo(protocoloBusca()!)">
                  🔎 Abrir protocolo <b class="proto">{{ protocoloFmtBusca() }}</b>
                </button>
                @if (servico.avisoBusca()) { <p class="aviso">{{ servico.avisoBusca() }}</p> }
              }
              @if (servico.vazio()) {
                <div class="vazio-lista">
                  <span class="icone">💬</span>
                  <p>Nenhuma conversa ainda. Elas aparecem aqui quando chegar uma mensagem.</p>
                </div>
              } @else if (conversasFiltradas().length === 0) {
                <p class="aviso">Nada encontrado para “{{ busca() }}”.</p>
              } @else {
                @for (c of conversasFiltradas(); track c.id) {
                  <button class="item" [class.ativo]="servico.selecionadaId() === c.id"
                          (click)="servico.abrir(c.id)">
                    <span class="av-wrap">
                      <span class="avatar" [style.background]="corAvatar(c.id)">{{ iniciais(c.nome) }}</span>
                      <app-canal-simbolo class="canal-badge" [tipo]="c.canalTipo" [tam]="16" />
                    </span>
                    <span class="col">
                      <span class="linha1">
                        <span class="nome">{{ c.nome }}</span>
                        <span class="hora">{{ hora(c.ultimaMensagemEm) }}</span>
                      </span>
                      <span class="linha2">
                        <span class="previa" [class.forte]="c.naoLida">{{ previaLista(c) || '—' }}</span>
                        @if (c.naoLida) { <span class="nao-lida" title="Não lida"></span> }
                        <span class="ponto-janela" [attr.data-estado]="c.janela.estado"
                              [title]="'Janela ' + rotuloJanela(c.janela.estado)"></span>
                      </span>
                    </span>
                  </button>
                }
              }
            }
          }
        </div>
      </aside>

      <!-- ───────── Conversa ───────── -->
      <section class="conversa">
        @switch (servico.estadoThread()) {
          @case ('nenhuma') {
            <div class="placeholder">
              <span class="icone">💬</span>
              <p>Selecione uma conversa para começar a atender.</p>
            </div>
          }
          @case ('carregando') { <div class="placeholder" aria-busy="true"><p>Abrindo…</p></div> }
          @case ('erro') { <div class="placeholder"><p>Não foi possível abrir esta conversa.</p></div> }
          @case ('pronto') {
            @if (servico.thread(); as t) {
              <header class="topo">
                <!-- Só no modo estreito (lista OU diálogo): volta para a lista. -->
                <button class="voltar" (click)="servico.voltarParaLista()" title="Voltar às conversas" aria-label="Voltar às conversas">‹</button>
                <span class="avatar" [style.background]="corAvatar(t.id)">{{ iniciais(t.nome) }}</span>
                <span class="topo-col">
                  <span class="nome-linha">
                    <span class="nome">{{ t.nome }}</span>
                    <app-canal-simbolo [tipo]="t.canalTipo" [tam]="18" />
                  </span>
                  <span class="sub" [attr.data-estado]="t.exigeJanela24h ? t.janela.estado : 'aberta'">{{ subConversa(t) }}</span>
                </span>
                <div class="topo-acoes">
                  <a class="pedido-btn" routerLink="/pedido" [queryParams]="{ conversa: t.id }"
                     title="Montar um pedido para este cliente">🛒 Montar pedido</a>
                  @if (t.atendimento) {
                    <span class="atend-badge" [title]="'Atendimento ' + protocoloFmt(t.atendimento.protocolo)">
                      @if (t.atendimento.protocolo) { <b class="proto">{{ protocoloFmt(t.atendimento.protocolo) }}</b> }
                      👤 {{ t.atendimento.atendenteNome || 'Em atendimento' }}
                    </span>
                  } @else {
                    <button class="assumir-btn" type="button" (click)="servico.assumir(t.id)">Assumir</button>
                  }
                </div>
              </header>

              <!-- Presença (INB-18): evita dois atendentes no mesmo cliente. -->
              @if (servico.presentes().length) {
                <div class="presenca" role="status">
                  👀 {{ textoPresenca(servico.presentes()) }}
                </div>
              }

              <div class="msgs" (click)="menuAbertoId.set(null); mostrarEmojis.set(false)">
                @if (t.temMaisAntigas) {
                  <button class="carregar-mais" type="button" (click)="servico.carregarAnteriores()"
                          [disabled]="servico.carregandoAnteriores()">
                    {{ servico.carregandoAnteriores() ? 'Carregando…' : 'Ver mensagens anteriores' }}
                  </button>
                }
                @if (t.mensagens.length === 0) {
                  <p class="sem-msg">Sem mensagens nesta conversa ainda.</p>
                }
                @for (m of t.mensagens; track m.id; let i = $index) {
                  @if (deveMostrarData(t.mensagens, i)) {
                    <div class="sep"><span>{{ rotuloData(m.criadoEm) }}</span></div>
                  }
                  <div class="bolha" [class.saliente]="m.direcao === 'saliente'"
                       [class.falhou]="m.status === 'falhou'" [class.apagada]="m.apagada">
                    @if (m.apagada) {
                      @if (m.tipo === 'imagem') {
                        <img class="msg-img apagada-img" [src]="imagemDe(m)" alt="imagem apagada" />
                        @if (legendaDe(m)) { <span class="txt apagada-txt">{{ legendaDe(m) }}</span> }
                      } @else {
                        <span class="txt apagada-txt">{{ texto(m) }}</span>
                      }
                      <span class="meta">
                        <span class="apg-badge" [title]="m.apagadaParaTodos ? 'Apagada para todos (recall no WhatsApp)' : 'Apagada só aqui'">🚫 apagada</span>
                        <span class="h">{{ hora(m.criadoEm) }}</span>
                      </span>
                    } @else if (editandoId() === m.id) {
                      <div class="edicao" (click)="$event.stopPropagation()">
                        <input [ngModel]="textoEdicao()" (ngModelChange)="textoEdicao.set($event)"
                               (keydown.enter)="salvarEdicao(t.id, m.id)" (keydown.escape)="cancelarEdicao()" />
                        <button class="ed-ok" (click)="salvarEdicao(t.id, m.id)" title="Salvar">✓</button>
                        <button class="ed-x" (click)="cancelarEdicao()" title="Cancelar">✕</button>
                      </div>
                    } @else {
                      @if (m.tipo === 'imagem') {
                        <img class="msg-img" [src]="imagemDe(m)" alt="imagem enviada" />
                        @if (legendaDe(m)) { <span class="txt legenda-img">{{ legendaDe(m) }}</span> }
                      } @else if (m.tipo === 'audio') {
                        <audio class="msg-audio" controls preload="none" [src]="audioDe(m)"></audio>
                      } @else if (m.tipo === 'acao') {
                        <div class="card-acao" [attr.data-estado]="acaoCampo(m,'estado')">
                          <div class="card-tit">📋 {{ acaoCampo(m,'titulo') }}</div>
                          @if (acaoCampo(m,'resumo')) { <div class="card-res">{{ acaoCampo(m,'resumo') }}</div> }
                          @if (acaoCampo(m,'estado') === 'pendente') {
                            <div class="card-opcoes">
                              @for (o of acaoOpcoes(m); track o.id) {
                                <button class="card-btn" [class.recusar]="o.id === 'recusar'"
                                        (click)="resolver(t.id, m.id, o.id)">{{ o.rotulo }}</button>
                              }
                            </div>
                          } @else {
                            <div class="card-resolvido">
                              {{ acaoCampo(m,'estado') === 'confirmado' ? '✅ Confirmado' : '❌ Recusado' }}
                            </div>
                          }
                        </div>
                      } @else {
                        <span class="txt">{{ texto(m) }}</span>
                      }
                      <span class="meta">
                        @if (m.editada) { <span class="editada">editada</span> }
                        <span class="h">{{ hora(m.criadoEm) }}</span>
                        @if (m.direcao === 'saliente') {
                          <span class="tique" [class.lida]="m.status === 'lida'">{{ tique(m.status) }}</span>
                        }
                      </span>
                      <button class="menu-btn" title="Opções" (click)="toggleMenu(m.id, $event)">⌄</button>
                      @if (menuAbertoId() === m.id) {
                        <div class="menu" (click)="$event.stopPropagation()">
                          @if (m.direcao === 'saliente' && m.tipo === 'texto') {
                            <button (click)="iniciarEdicao(m)">Editar</button>
                            <button (click)="apagar(t.id, m.id, true)">Apagar para todos</button>
                          }
                          <button (click)="apagar(t.id, m.id, false)">Apagar para mim</button>
                        </div>
                      }
                    }
                  </div>
                }
              </div>

              <footer class="composer">
                <!-- ⚠️ Só o WhatsApp Oficial (Meta) tem janela/template. No
                     não-oficial o composer fica sempre livre. -->
                @if (!t.exigeJanela24h || janelaAberta(t.janela.estado)) {
                  @if (mostrarEmojis()) {
                    <div class="emoji-panel" (click)="$event.stopPropagation()">
                      @for (e of EMOJIS; track e) {
                        <button type="button" class="emoji" (click)="inserirEmoji(e)">{{ e }}</button>
                      }
                    </div>
                  }
                  <button class="ic" type="button" title="Emoji" (click)="toggleEmojis($event)">😊</button>
                  <button class="ic" type="button" title="Enviar imagem" (click)="arquivoImg.click()"
                          [disabled]="servico.enviando()">＋</button>
                  <input #arquivoImg type="file" accept="image/*" hidden
                         (change)="aoEscolherImagem($event, t.id)" />
                  <button class="ic" type="button" title="Gerar pedido" (click)="gerarPedido(t.id)">📋</button>
                  <input class="entrada" type="text" placeholder="Digite uma mensagem"
                         [ngModel]="servico.rascunho()" (ngModelChange)="servico.rascunho.set($event)"
                         (keydown.enter)="servico.enviar()" [disabled]="servico.enviando()" />
                  @if (servico.rascunho().trim()) {
                    <button class="enviar" type="button" (click)="servico.enviar()"
                            [disabled]="servico.enviando()"
                            [title]="servico.enviando() ? 'Enviando…' : 'Enviar'">➤</button>
                  } @else {
                    <button class="enviar" type="button" [class.gravando]="gravando()"
                            (click)="alternarGravacao(t.id)" [disabled]="servico.enviando()"
                            [title]="gravando() ? 'Parar e enviar' : 'Gravar áudio'">{{ gravando() ? '⏹' : '🎤' }}</button>
                  }
                } @else {
                  <div class="fechada">
                    ⚠️ Janela de 24h fechada — só um <strong>template</strong> aprovado reabre a conversa.
                  </div>
                }
                @if (servico.erroEnvio()) { <p class="erro-envio">{{ servico.erroEnvio() }}</p> }
              </footer>
            }
          }
        }
      </section>
    </div>
  `,
  styles: `
    /* ⚠️ Layout estilo WhatsApp, mas COR pela identidade do app (neutro + azul,
       claro/escuro) — os apelidos --wa-* agora apontam para os tokens, então o
       inbox é coeso com o resto e troca de tema junto. */
    :host {
      --wa-sidebar: var(--superficie); --wa-panel: var(--superficie-elevada); --wa-hover: var(--superficie-hover);
      --wa-chat: var(--fundo); --wa-in: var(--superficie-elevada); --wa-out: var(--acao-suave);
      --wa-text: var(--texto); --wa-sec: var(--texto-secundario); --wa-green: var(--acao);
      --wa-line: var(--borda);
      display: block; height: 100%; min-height: 0; color: var(--wa-text);
      /* ⚠️ O inbox reage à PRÓPRIA largura (é filho do rail redimensionável),
         não à da janela — container query em vez de @media. */
      container-type: inline-size;
      --inboxbuild-b13: 1;
    }
    .wa {
      /* Lista com largura FIXA (~300px) e o diálogo cresce com o resto — assim o
         diálogo aproveita toda a largura extra do painel, sem a lista inchar. */
      height: 100%; display: grid; grid-template-columns: 300px 1fr;
      background: var(--wa-chat); overflow: hidden;
      font-family: var(--tipografia-familia-interface);
    }
    /* Botão "voltar" só no modo estreito (lista OU diálogo). */
    .voltar { display: none; border: 0; background: transparent; color: var(--wa-sec);
      font-size: 22px; line-height: 1; cursor: pointer; padding: 4px 8px; margin-left: -4px;
      border-radius: var(--raio-controle); flex: none; }
    .voltar:hover { background: var(--wa-hover); color: var(--wa-text); }

    /* ── Lista ── */
    .lista { display: flex; flex-direction: column; background: var(--wa-sidebar); border-right: 1px solid var(--wa-line); min-height: 0; }
    .barra { height: 56px; display: flex; align-items: center; gap: 10px; padding: 0 16px; background: var(--wa-panel); }
    .titulo { font-size: 16px; font-weight: 600; }
    .conexao { margin-left: auto; font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 999px; }
    .conexao::before { content: '●'; margin-right: 4px; }
    .conexao[data-estado='conectado'] { color: #14e39c; }
    .conexao[data-estado='conectando'], .conexao[data-estado='reconectando'] { color: #e0b341; }
    .conexao[data-estado='offline'] { color: #ff6b5e; }

    .busca-wrap { padding: 8px 12px; position: relative; }
    .lupa { position: absolute; left: 24px; top: 50%; transform: translateY(-50%); font-size: 12px; opacity: .6; }
    .busca { width: 100%; padding: 8px 12px 8px 34px; border: 0; border-radius: 8px; background: var(--wa-panel); color: var(--wa-text); font: inherit; font-size: 14px; }
    .busca::placeholder { color: var(--wa-sec); }
    .busca:focus { outline: 1px solid var(--wa-green); }

    .abas { display: flex; gap: 4px; padding: 0 12px 8px; }
    .abas button { flex: 1; padding: 7px 8px; border: 0; border-radius: 8px; cursor: pointer; font: inherit; font-size: 13px; background: var(--wa-panel); color: var(--wa-sec); display: inline-flex; align-items: center; justify-content: center; gap: 5px; }
    .abas button.ativa { background: var(--wa-hover); color: var(--wa-text); font-weight: 600; }
    .abas .cont { background: var(--wa-green); color: #04231d; font-size: 11px; font-weight: 700; padding: 0 6px; border-radius: 999px; min-width: 18px; text-align: center; }
    .itens { flex: 1; overflow-y: auto; min-height: 0; }
    .item { width: 100%; display: flex; align-items: center; gap: 12px; padding: 10px 14px; background: none; border: 0; border-bottom: 1px solid var(--wa-line); cursor: pointer; text-align: left; color: inherit; }
    .item:hover { background: var(--wa-hover); }
    .item.ativo { background: var(--wa-hover); }
    .avatar { flex: none; width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; color: #fff; font-size: 15px; font-weight: 600; }
    /* Selo de canal no canto do avatar (multicanal). */
    .av-wrap { flex: none; position: relative; display: inline-grid; }
    .canal-badge { position: absolute; bottom: -3px; right: -3px; box-shadow: 0 0 0 2px var(--wa-sidebar, var(--superficie)); border-radius: 6px; }
    .col { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .linha1, .linha2 { display: flex; align-items: center; gap: 8px; }
    .nome { flex: 1; min-width: 0; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hora { flex: none; font-size: 11px; color: var(--wa-sec); }
    .previa { flex: 1; min-width: 0; font-size: 13px; color: var(--wa-sec); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .previa.forte { color: var(--wa-text); font-weight: 600; }
    .nao-lida { flex: none; width: 9px; height: 9px; border-radius: 50%; background: var(--wa-green); }
    .ponto-janela { flex: none; width: 8px; height: 8px; border-radius: 50%; }
    .ponto-janela[data-estado='aberta'] { background: var(--wa-green); }
    .ponto-janela[data-estado='terminando'] { background: #e0b341; }
    .ponto-janela[data-estado='fechada'] { background: transparent; }
    .proto-busca { color: var(--wa-green); font-weight: 600; justify-content: flex-start; gap: 6px; }
    .proto-busca .proto { color: var(--wa-green); font-variant-numeric: tabular-nums; }
    .esqueleto { height: 44px; margin: 10px 14px; border-radius: 8px; background: linear-gradient(90deg, var(--wa-panel), var(--wa-hover), var(--wa-panel)); background-size: 200% 100%; animation: brilho 1.3s infinite; }
    @keyframes brilho { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }
    .aviso, .vazio-lista { padding: 24px 18px; color: var(--wa-sec); font-size: 13px; text-align: center; }
    .vazio-lista .icone { font-size: 32px; display: block; margin-bottom: 8px; }
    .aviso button { margin-top: 10px; padding: 6px 12px; border: 0; border-radius: 6px; background: var(--wa-green); color: #04231d; font-weight: 600; cursor: pointer; }

    /* ── Conversa ── */
    .conversa { display: flex; flex-direction: column; min-height: 0; background: var(--wa-chat); position: relative; }
    /* leve textura no fundo do chat */
    .conversa::before { content: ''; position: absolute; inset: 0; opacity: .04; pointer-events: none;
      background-image: radial-gradient(var(--wa-text) 1px, transparent 1px); background-size: 22px 22px; }
    .placeholder { flex: 1; display: grid; place-content: center; justify-items: center; gap: 10px; color: var(--wa-sec); text-align: center; padding: 24px; }
    .placeholder .icone { font-size: 48px; }

    .topo { height: 56px; display: flex; align-items: center; gap: 12px; padding: 0 16px; background: var(--wa-panel); z-index: 1; }
    .topo .avatar { width: 40px; height: 40px; font-size: 14px; }
    .topo-col { display: flex; flex-direction: column; }
    .nome-linha { display: flex; align-items: center; gap: 7px; }
    .topo-acoes { margin-left: auto; }
    .assumir-btn { border: 0; background: var(--wa-green); color: #04231d; font-weight: 600; padding: 7px 14px; border-radius: 8px; cursor: pointer; font-size: 13px; }
    .pedido-btn { font-size: 12px; color: var(--wa-text); background: rgba(255,255,255,.1); padding: 6px 12px; border-radius: 999px; text-decoration: none; white-space: nowrap; }
    .pedido-btn:hover { background: rgba(255,255,255,.18); }
    .atend-badge { font-size: 12px; color: var(--wa-text); background: rgba(255,255,255,.1); padding: 5px 10px; border-radius: 999px; }
    .atend-badge .proto { color: #14e39c; margin-right: 4px; font-variant-numeric: tabular-nums; }
    .topo-col .nome { font-size: 15px; font-weight: 600; }
    .sub { font-size: 12px; color: var(--wa-sec); }
    .presenca { padding: 6px 16px; font-size: 12px; color: var(--wa-text); background: var(--acao-suave); border-bottom: 1px solid var(--wa-line); }
    .sub[data-estado='aberta'] { color: var(--wa-green); }
    .sub[data-estado='terminando'] { color: #e0b341; }
    .sub[data-estado='fechada'] { color: #ff6b5e; }

    .msgs { flex: 1; overflow-y: auto; min-height: 0; padding: 16px 8%; display: flex; flex-direction: column; gap: 3px; z-index: 1; }
    .sem-msg { text-align: center; color: var(--wa-sec); font-size: 13px; margin: auto; }
    .carregar-mais { align-self: center; margin-bottom: 10px; padding: 6px 14px; border: 0; border-radius: 999px; background: var(--wa-panel); color: var(--wa-text); font-size: 12px; cursor: pointer; }
    .sep { align-self: center; margin: 12px 0; }
    .sep span { background: var(--wa-panel); color: var(--wa-sec); font-size: 11px; padding: 5px 12px; border-radius: 8px; text-transform: uppercase; letter-spacing: .03em; }
    .bolha { position: relative; max-width: 65%; align-self: flex-start; background: var(--wa-in); color: var(--wa-text);
      padding: 6px 9px 8px; border-radius: 8px; border-top-left-radius: 0; font-size: 14.2px; line-height: 1.35;
      box-shadow: 0 1px 0 rgba(0,0,0,.2); word-wrap: break-word; }
    .bolha.saliente { align-self: flex-end; background: var(--wa-out); border-top-left-radius: 8px; border-top-right-radius: 0; }
    .bolha.falhou { outline: 1px solid #ff6b5e; }
    .txt { white-space: pre-wrap; }
    .msg-img { max-width: 260px; max-height: 340px; border-radius: 6px; display: block; cursor: pointer; }
    .legenda-img { display: block; margin-top: 4px; }
    .msg-audio { display: block; height: 40px; max-width: 260px; }
    /* Card de ação (pedido/orçamento) */
    .card-acao { min-width: 220px; }
    .card-tit { font-weight: 600; margin-bottom: 4px; }
    .card-res { font-size: 13px; opacity: .85; margin-bottom: 8px; white-space: pre-wrap; }
    .card-opcoes { display: flex; gap: 8px; margin-top: 6px; }
    .card-btn { flex: 1; padding: 7px 10px; border: 0; border-radius: 8px; cursor: pointer; font: inherit; font-weight: 600; background: var(--wa-green); color: #04231d; }
    .card-btn.recusar { background: rgba(255,255,255,.15); color: var(--wa-text); }
    .card-resolvido { margin-top: 6px; font-size: 13px; font-weight: 600; }
    .card-acao[data-estado='recusado'] .card-resolvido { color: #ff9a8e; }
    .enviar.gravando { background: var(--erro); color: var(--texto-invertido); animation: pulsa 1s infinite; }
    @keyframes pulsa { 0%,100% { opacity: 1 } 50% { opacity: .55 } }
    .meta { float: right; margin: 6px 0 -2px 8px; display: inline-flex; align-items: center; gap: 3px; }
    .meta .h { font-size: 10.5px; color: var(--wa-sec); }
    .bolha.saliente .meta .h { color: rgba(233,237,239,.6); }
    .tique { font-size: 11px; color: rgba(233,237,239,.6); }
    .tique.lida { color: var(--acao); }
    .editada { font-size: 10.5px; color: var(--wa-sec); font-style: italic; margin-right: 2px; }
    .bolha.saliente .editada { color: rgba(233,237,239,.55); }
    /* Apagada: NÃO some — fica riscada/esmaecida, marcada como "desconsiderar". */
    .bolha.apagada { opacity: .9; }
    .apagada .txt.apagada-txt { text-decoration: line-through; opacity: .55; }
    .apagada-img { opacity: .4; filter: grayscale(.6); }
    .apg-badge { font-size: 10px; color: #ff9a8e; font-style: italic; margin-right: 4px; }
    /* Menu de opções da bolha */
    .menu-btn { position: absolute; top: 1px; right: 2px; border: 0; background: rgba(0,0,0,.18); color: var(--wa-text); cursor: pointer; font-size: 15px; line-height: 1; opacity: .6; padding: 1px 5px 3px; border-radius: 10px; }
    .bolha:hover .menu-btn { opacity: 1; }
    .menu-btn:hover { background: rgba(0,0,0,.35); }
    .menu { position: absolute; top: 20px; right: 4px; z-index: 5; background: var(--wa-panel); border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.45); overflow: hidden; min-width: 150px; }
    .menu button { display: block; width: 100%; text-align: left; padding: 9px 14px; border: 0; background: none; color: var(--wa-text); font: inherit; font-size: 13.5px; cursor: pointer; }
    .menu button:hover { background: var(--wa-hover); }
    .edicao { display: flex; align-items: center; gap: 6px; }
    .edicao input { flex: 1; min-width: 160px; padding: 6px 8px; border: 0; border-radius: 6px; background: rgba(0,0,0,.25); color: var(--wa-text); font: inherit; }
    .edicao button { border: 0; width: 26px; height: 26px; border-radius: 50%; cursor: pointer; }
    .ed-ok { background: var(--wa-green); color: #04231d; }
    .ed-x { background: var(--wa-hover); color: var(--wa-text); }

    /* ── Composer ── */
    .composer { position: relative; min-height: 56px; display: flex; align-items: center; gap: 10px; padding: 8px 16px; background: var(--wa-panel); flex-wrap: wrap; z-index: 1; }
    .emoji-panel { position: absolute; left: 12px; bottom: 60px; width: min(360px, 80%); max-height: 240px; overflow-y: auto; padding: 8px; background: var(--wa-panel); border: 1px solid var(--wa-line); border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.5); display: grid; grid-template-columns: repeat(10, 1fr); gap: 2px; z-index: 6; }
    .emoji { border: 0; background: none; cursor: pointer; font-size: 20px; padding: 4px; border-radius: 6px; line-height: 1; }
    .emoji:hover { background: var(--wa-hover); }
    .ic { flex: none; width: 34px; height: 34px; border: 0; border-radius: 50%; background: none; color: var(--wa-sec); font-size: 20px; cursor: pointer; }
    .ic:disabled { opacity: .5; cursor: default; }
    .entrada { flex: 1; padding: 10px 14px; border: 0; border-radius: 20px; background: var(--wa-hover); color: var(--wa-text); font: inherit; font-size: 14px; }
    .entrada::placeholder { color: var(--wa-sec); }
    .entrada:focus { outline: none; }
    .enviar { flex: none; width: 40px; height: 40px; border: 0; border-radius: 50%; background: var(--wa-green); color: #04231d; font-size: 16px; cursor: pointer; display: grid; place-items: center; }
    .enviar:disabled { background: var(--wa-hover); color: var(--wa-sec); cursor: default; }
    .fechada { flex: 1; font-size: 13px; color: #e0b341; text-align: center; }
    .erro-envio { width: 100%; margin: 0; font-size: 12px; color: #ff6b5e; }

    /* Rail estreito: uma coluna só. Sem conversa aberta → lista; com conversa →
       diálogo em largura total + botão "voltar". Assim o diálogo nunca fica
       espremido, mesmo num painel estreito. Baseado na largura do PRÓPRIO inbox. */
    @container (max-width: 680px) {
      .wa { grid-template-columns: 1fr; }
      .lista { border-right: 0; }
      .conversa { display: none; }
      .wa.tem-conversa .lista { display: none; }
      .wa.tem-conversa .conversa { display: flex; }
      .voltar { display: inline-flex; align-items: center; }
    }
  `,
})
export class InboxPagina implements OnDestroy {
  readonly servico = inject(InboxServico)
  readonly eventos = inject(EventosServico)

  readonly busca = signal('')
  // Busca por protocolo (E5-08): "#000318" | "318" → número.
  readonly protocoloBusca = computed<number | null>(() => parsearProtocolo(this.busca()))
  protocoloFmtBusca(): string { const n = this.protocoloBusca(); return n ? formatarProtocolo(n) : '' }
  readonly conversasFiltradas = computed<readonly ItemConversa[]>(() => {
    const q = this.busca().trim().toLowerCase()
    const cs = this.servico.conversas()
    if (!q) return cs
    return cs.filter(
      (c) => c.nome.toLowerCase().includes(q) || (c.ultimaMensagem?.texto ?? '').toLowerCase().includes(q),
    )
  })

  ngOnDestroy(): void {
    // ⚠️ Apresentacional: o carregamento da lista, o ouvinte SSE e o ?abrir= agora
    //    vivem no ChatRailComponente (sempre montado). Ao recolher o rail este
    //    componente some, então sair da conversa (presença) é o certo aqui.
    this.servico.pararPresenca()
  }

  /** "Ana está nesta conversa" · "Ana e Bia…" · "Ana e mais 2 estão…" */
  textoPresenca(nomes: readonly string[]): string {
    if (nomes.length === 1) return `${nomes[0]} está nesta conversa`
    if (nomes.length === 2) return `${nomes[0]} e ${nomes[1]} estão nesta conversa`
    return `${nomes[0]} e mais ${nomes.length - 1} estão nesta conversa`
  }

  rotuloConexao(): string {
    switch (this.eventos.estado()) {
      case 'conectado': return 'Ao vivo'
      case 'conectando': return 'Conectando'
      case 'reconectando': return 'Reconectando'
      case 'offline': return 'Offline'
      default: return ''
    }
  }

  rotuloJanela(estado: string): string {
    return estado === 'aberta' ? 'aberta' : estado === 'terminando' ? 'terminando' : 'fechada'
  }
  janelaAberta(estado: string): boolean { return estado === 'aberta' || estado === 'terminando' }

  protocoloFmt(n: number | null): string { return n ? formatarProtocolo(n) : '' }

  subConversa(t: Thread): string {
    // Não-oficial (PlugZapi): sem janela de 24h — sempre texto livre.
    if (!t.exigeJanela24h) return 'WhatsApp não-oficial • texto livre'
    if (t.janela.estado === 'fechada') return 'Janela de 24h fechada'
    const h = Math.max(0, Math.round(t.janela.restanteMs / 3_600_000))
    return `Janela aberta • ${h}h restantes`
  }

  texto(m: Mensagem): string {
    const c = m.conteudo as { texto?: string } | null
    if (c && typeof c === 'object' && typeof c.texto === 'string') return c.texto
    return `[${m.tipo}]`
  }

  imagemDe(m: Mensagem): string {
    const c = m.conteudo as { imagem?: string; dataUrl?: string } | null
    return c?.imagem ?? c?.dataUrl ?? ''
  }
  legendaDe(m: Mensagem): string {
    const c = m.conteudo as { legenda?: string } | null
    return typeof c?.legenda === 'string' ? c.legenda : ''
  }

  /** ＋ do composer: escolhe imagem, lê como data URL e envia (legenda = rascunho). */
  aoEscolherImagem(ev: Event, conversaId: string): void {
    const input = ev.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = '' // permite reescolher o mesmo arquivo
    if (!file) return
    if (file.size > 3 * 1024 * 1024) {
      this.servico.erroEnvio.set('Imagem muito grande (máx. 3 MB).')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const legenda = this.servico.rascunho().trim() || undefined
      void this.servico.enviarImagem(conversaId, String(reader.result), legenda)
    }
    reader.readAsDataURL(file)
  }

  audioDe(m: Mensagem): string {
    const c = m.conteudo as { audio?: string; audioUrl?: string } | null
    return c?.audio ?? c?.audioUrl ?? ''
  }

  // Card de ação (pedido/orçamento…).
  acaoCampo(m: Mensagem, campo: string): string {
    const c = m.conteudo as Record<string, unknown> | null
    const v = c?.[campo]
    return typeof v === 'string' ? v : ''
  }
  acaoOpcoes(m: Mensagem): { id: string; rotulo: string }[] {
    const c = m.conteudo as { opcoes?: { id: string; rotulo: string }[] } | null
    return c?.opcoes ?? []
  }
  async resolver(conversaId: string, mid: string, opcaoId: string): Promise<void> {
    await this.servico.resolverAcao(conversaId, mid, opcaoId)
  }
  /** "Gerar pedido": cria um card de ação de pedido (rascunho = texto do composer). */
  async gerarPedido(conversaId: string): Promise<void> {
    const resumo = this.servico.rascunho().trim() || 'Rascunho de pedido — revise e confirme.'
    this.servico.rascunho.set('')
    await this.servico.criarAcao(conversaId, {
      acao: 'pedido',
      titulo: 'Pedido',
      resumo,
      opcoes: [{ id: 'confirmar', rotulo: 'Confirmar' }, { id: 'recusar', rotulo: 'Recusar' }],
    })
  }

  // Gravação de áudio (mensagem de voz).
  readonly gravando = signal(false)
  private gravador?: MediaRecorder
  private pedacos: Blob[] = []

  async alternarGravacao(conversaId: string): Promise<void> {
    if (this.gravando()) { this.gravador?.stop(); return }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      this.pedacos = []
      const mr = new MediaRecorder(stream)
      this.gravador = mr
      mr.ondataavailable = (e) => { if (e.data.size) this.pedacos.push(e.data) }
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        this.gravando.set(false)
        if (this.pedacos.length === 0) return
        const blob = new Blob(this.pedacos, { type: mr.mimeType || 'audio/webm' })
        const reader = new FileReader()
        reader.onload = () => void this.servico.enviarAudio(conversaId, String(reader.result))
        reader.readAsDataURL(blob)
      }
      mr.start()
      this.gravando.set(true)
    } catch {
      this.servico.erroEnvio.set('Não foi possível acessar o microfone.')
    }
  }

  // Menu de mensagem (apagar / editar), como no WhatsApp.
  readonly menuAbertoId = signal<string | null>(null)
  readonly editandoId = signal<string | null>(null)
  readonly textoEdicao = signal('')

  toggleMenu(id: string, ev: Event): void {
    ev.stopPropagation()
    this.menuAbertoId.set(this.menuAbertoId() === id ? null : id)
  }
  iniciarEdicao(m: Mensagem): void {
    this.editandoId.set(m.id)
    this.textoEdicao.set(this.texto(m))
    this.menuAbertoId.set(null)
  }
  cancelarEdicao(): void { this.editandoId.set(null) }
  async salvarEdicao(conversaId: string, mid: string): Promise<void> {
    const t = this.textoEdicao().trim()
    if (!t) return
    this.editandoId.set(null)
    await this.servico.editarMensagem(conversaId, mid, t)
  }
  async apagar(conversaId: string, mid: string, paraTodos: boolean): Promise<void> {
    this.menuAbertoId.set(null)
    await this.servico.apagarMensagem(conversaId, mid, paraTodos)
  }

  // Seletor de emoji do composer.
  readonly mostrarEmojis = signal(false)
  toggleEmojis(ev: Event): void { ev.stopPropagation(); this.mostrarEmojis.set(!this.mostrarEmojis()) }
  inserirEmoji(e: string): void { this.servico.rascunho.update((v) => v + e) }
  readonly EMOJIS = [
    '😀','😃','😄','😁','😆','😅','😂','🤣','😊','😇','🙂','🙃','😉','😌','😍','🥰','😘','😗','😙','😚',
    '😋','😛','😝','😜','🤪','🤨','🧐','🤓','😎','🥳','😏','😒','😔','😟','🙁','☹️','😣','😖','😫','😩',
    '🥺','😢','😭','😤','😠','😡','🤬','🤯','😳','🥵','🥶','😱','😨','😰','😥','😓','🤗','🤔','🤭','🤫',
    '😶','😐','😑','😬','🙄','😯','😴','🤤','😵','🥴','🤢','🤮','🤧','😷','🤒','🤕','👍','👎','👌','✌️',
    '🤞','🤙','👏','🙌','🙏','💪','👀','🔥','⭐','🎉','❤️','🧡','💛','💚','💙','💜','🖤','💔','✅','❌',
    '⚠️','💰','📎','📷','🎤','😅','🥹','🫶','🤝','👋',
  ]

  previaLista(c: ItemConversa): string {
    const um = c.ultimaMensagem
    if (!um) return ''
    return (um.direcao === 'saliente' ? 'Você: ' : '') + um.texto
  }

  // Avatar: iniciais + cor estável por id.
  private readonly CORES = ['#6a4bb6', '#00786b', '#2a6fc9', '#b0417a', '#4e37a8', '#00747f', '#3a8f45', '#c0552b', '#5d6d7e', '#9c5b23']
  corAvatar(id: string): string {
    let h = 0
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
    return this.CORES[h % this.CORES.length]!
  }
  iniciais(nome: string): string {
    const p = (nome || '?').trim().split(/\s+/)
    const a = p[0]?.[0] ?? ''
    const b = p.length > 1 ? (p[p.length - 1]?.[0] ?? '') : ''
    return (a + b).toUpperCase() || '?'
  }

  hora(iso: string | null): string {
    if (!iso) return ''
    return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  }
  private soData(iso: string): string { return new Date(iso).toDateString() }
  deveMostrarData(ms: readonly Mensagem[], i: number): boolean {
    if (i === 0) return true
    return this.soData(ms[i]!.criadoEm) !== this.soData(ms[i - 1]!.criadoEm)
  }
  rotuloData(iso: string): string {
    const d = new Date(iso)
    const hoje = new Date()
    const ontem = new Date(); ontem.setDate(hoje.getDate() - 1)
    if (d.toDateString() === hoje.toDateString()) return 'Hoje'
    if (d.toDateString() === ontem.toDateString()) return 'Ontem'
    return d.toLocaleDateString('pt-BR')
  }
  tique(status: string | null): string {
    switch (status) {
      case 'enviada': return '✓'
      case 'entregue': case 'lida': return '✓✓'
      case 'falhou': return '⚠'
      default: return '🕗'
    }
  }
}
