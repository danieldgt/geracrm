import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { TemplatesServico, type CorpoTemplate, type ItemTemplate } from './templates.servico.js'

interface Rascunho { id: string | null; nome: string; categoria: string; header: string; body: string; footer: string; botoes: string }
const VAZIO: Rascunho = { id: null, nome: '', categoria: 'MARKETING', header: '', body: '', footer: '', botoes: '' }
const ROTULO_STATUS: Record<string, string> = {
  PENDING: 'Aguardando Meta', APPROVED: 'Aprovado', REJECTED: 'Rejeitado', PAUSED: 'Pausado', DISABLED: 'Desabilitado',
}
const ERRO_CRIAR: Record<string, string> = {
  'nome.invalido': 'Nome inválido: use minúsculas, números e _.',
  'categoria.invalida': 'Escolha uma categoria.',
  'corpo.body_vazio': 'O corpo (body) é obrigatório.',
  'corpo.body_longo': 'O corpo passou de 1024 caracteres.',
  'template.ja_existe': 'Já existe um template com esse nome e idioma.',
}

/**
 * Templates (HSM) — o que reabre a janela de 24h. Catálogo com status da Meta,
 * criar/editar (nova versão) e apagar rascunho. ⚠️ A aprovação é da Meta: a tela
 * mostra o status e diz claramente que a submissão ainda não está conectada.
 */
@Component({
  selector: 'app-templates',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <header class="cabecalho">
      <div>
        <h1 class="txt-titulo">Templates (HSM)</h1>
        <p class="sub">Mensagens aprovadas na Meta — o que reabre a janela de 24h.</p>
      </div>
      <button class="btn-novo" (click)="abrirNovo()">＋ Novo template</button>
    </header>

    <p class="nota">ℹ️ A aprovação vem da Meta. Enquanto o canal oficial não está conectado, o template fica <b>Aguardando Meta</b> — o envio só usa os <b>Aprovados</b>.</p>
    @if (servico.erro(); as e) { <p class="erro" role="alert">{{ e }}</p> }

    @switch (servico.estado()) {
      @case ('carregando') { <div class="grade"><div class="esq"></div><div class="esq"></div><div class="esq"></div></div> }
      @case ('sem_permissao') { <div class="bloco"><h2 class="txt-secao">Sem acesso aos templates</h2></div> }
      @case ('erro') { <div class="bloco"><h2 class="txt-secao">Não foi possível carregar</h2><button (click)="servico.carregar()">Tentar de novo</button></div> }
      @case ('pronto') {
        @if (servico.itens().length === 0) {
          <div class="bloco"><h2 class="txt-secao">Nenhum template ainda</h2>
            <p class="vazio-sub">Crie o primeiro — ele nasce como rascunho até a Meta aprovar.</p>
            <button class="btn-novo" (click)="abrirNovo()">＋ Novo template</button></div>
        } @else {
          <div class="grade">
            @for (t of servico.itens(); track t.id) {
              <article class="tpl">
                <header class="tpl-topo">
                  <span class="tpl-nome encolhe">{{ t.nome }}</span>
                  <span class="status" [class]="'status--' + t.statusMeta.toLowerCase()">{{ rotulo(t.statusMeta) }}</span>
                </header>
                <div class="tpl-tags">
                  <span class="tag">{{ t.categoria }}</span>
                  <span class="tag">{{ t.idioma }}</span>
                  <span class="tag">v{{ t.versao }}</span>
                </div>
                @if (t.corpo?.header?.texto) { <p class="tpl-header">{{ t.corpo.header!.texto }}</p> }
                <p class="tpl-body">{{ t.corpo?.body?.texto }}</p>
                @if (t.corpo?.footer?.texto) { <p class="tpl-footer">{{ t.corpo.footer!.texto }}</p> }
                @if (t.corpo?.botoes?.length) {
                  <div class="tpl-botoes">@for (b of t.corpo.botoes!; track $index) { <span class="btn-chip">{{ b.texto }}</span> }</div>
                }
                @if (t.statusMeta === 'REJECTED' && t.motivoRejeicao) {
                  <p class="rejeicao">✕ {{ t.motivoRejeicao }}</p>
                }
                <footer class="tpl-acoes">
                  <button (click)="abrirEdicao(t)">Editar (nova versão)</button>
                  @if (!t.submetido) { <button class="del" (click)="apagar(t)">Apagar</button> }
                </footer>
              </article>
            }
          </div>
          @if (servico.proximoCursor()) {
            <button class="mais" (click)="servico.carregarMais()" [disabled]="servico.carregandoMais()">
              {{ servico.carregandoMais() ? 'Carregando…' : 'Carregar mais' }}
            </button>
          }
        }
      }
    }

    <!-- Form de criar/editar -->
    @if (rascunho(); as r) {
      <div class="fora" (click)="fechar()"></div>
      <div class="modal" role="dialog" aria-label="Template">
        <header class="m-topo">
          <h2 class="txt-secao">{{ r.id ? 'Editar template (nova versão)' : 'Novo template' }}</h2>
          <button class="m-x" (click)="fechar()" aria-label="Fechar">✕</button>
        </header>
        @if (erroForm(); as e) { <p class="erro" role="alert">{{ e }}</p> }
        <label class="campo">
          <span>Nome (identificador na Meta)</span>
          <input [(ngModel)]="r.nome" [disabled]="!!r.id" placeholder="reposicao_mensal" (input)="normalizarNome(r)" />
          <small>Minúsculas, números e _ . Não muda depois de criado.</small>
        </label>
        <label class="campo">
          <span>Categoria</span>
          <select [(ngModel)]="r.categoria" [disabled]="!!r.id">
            <option value="MARKETING">Marketing</option>
            <option value="UTILITY">Utilidade</option>
            <option value="AUTHENTICATION">Autenticação</option>
          </select>
        </label>
        <label class="campo"><span>Cabeçalho (opcional)</span><input [(ngModel)]="r.header" maxlength="60" placeholder="Novidades" /></label>
        <label class="campo">
          <span>Corpo *</span>
          <textarea [(ngModel)]="r.body" rows="4" maxlength="1024" placeholder="Olá {{ '{{' }}1{{ '}}' }}, chegou reposição do que você compra."></textarea>
          <small>Variáveis posicionais: {{ '{{' }}1{{ '}}' }}, {{ '{{' }}2{{ '}}' }}…</small>
        </label>
        <label class="campo"><span>Rodapé (opcional)</span><input [(ngModel)]="r.footer" maxlength="60" placeholder="Sua loja" /></label>
        <label class="campo"><span>Botões (opcional, até 3, separados por vírgula)</span><input [(ngModel)]="r.botoes" placeholder="Ver ofertas, Falar com vendedor" /></label>
        <div class="m-acoes">
          <button class="cancelar" (click)="fechar()">Cancelar</button>
          <button class="salvar" (click)="salvar(r)" [disabled]="salvando() || !r.nome.trim() || !r.body.trim()">
            {{ salvando() ? 'Salvando…' : r.id ? 'Salvar nova versão' : 'Criar rascunho' }}
          </button>
        </div>
      </div>
    }
  `,
  styles: `
    :host { display: block; height: 100%; padding: var(--espacamento-6); overflow: auto; }
    .cabecalho { margin-bottom: var(--espacamento-3); display: flex; align-items: flex-start; justify-content: space-between; gap: var(--espacamento-4); }
    h1 { margin: 0; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .btn-novo { flex: none; padding: var(--espacamento-2) var(--espacamento-4); border: 1px solid var(--acao); border-radius: var(--raio-controle); background: var(--acao); color: var(--acao-texto); font: inherit; font-size: 13px; cursor: pointer; }
    .nota { margin: 0 0 var(--espacamento-4); padding: var(--espacamento-3); border: 1px solid var(--borda); border-radius: var(--raio-controle); background: var(--superficie); color: var(--texto-secundario); font-size: 12px; }
    .erro { margin: 0 0 var(--espacamento-3); color: var(--erro); font-size: 13px; }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; }
    .vazio-sub { margin: var(--espacamento-2) 0 var(--espacamento-4); color: var(--texto-secundario); font-size: 13px; }
    .grade { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: var(--espacamento-3); }
    .esq { height: 180px; border-radius: var(--raio-painel); background: var(--superficie); }
    .tpl { display: flex; flex-direction: column; gap: var(--espacamento-2); padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .tpl-topo { display: flex; align-items: center; justify-content: space-between; gap: var(--espacamento-2); }
    .tpl-nome { font-weight: 600; color: var(--texto); font-family: var(--fonte-mono, monospace); font-size: 13px; }
    .status { flex: none; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: var(--raio-completo); }
    .status--approved { background: var(--sucesso-suave); color: var(--sucesso); }
    .status--pending { background: var(--atencao-suave); color: var(--atencao); }
    .status--rejected { background: var(--erro-suave); color: var(--erro); }
    .status--paused, .status--disabled { background: var(--superficie); color: var(--texto-suave); }
    .tpl-tags { display: flex; flex-wrap: wrap; gap: 4px; }
    .tag { font-size: 10px; color: var(--texto-suave); border: 1px solid var(--borda); border-radius: var(--raio-completo); padding: 0 7px; }
    .tpl-header { margin: 0; font-weight: 600; color: var(--texto); font-size: 13px; }
    .tpl-body { margin: 0; color: var(--texto-secundario); font-size: 13px; white-space: pre-wrap; }
    .tpl-footer { margin: 0; color: var(--texto-suave); font-size: 12px; }
    .tpl-botoes { display: flex; flex-wrap: wrap; gap: 4px; }
    .btn-chip { font-size: 11px; color: var(--acao); border: 1px solid var(--acao-suave); background: var(--acao-suave); border-radius: var(--raio-controle); padding: 1px 8px; }
    .rejeicao { margin: 0; font-size: 12px; color: var(--erro); }
    .tpl-acoes { display: flex; gap: var(--espacamento-2); margin-top: var(--espacamento-1); }
    .tpl-acoes button { flex: 1; padding: 5px 8px; border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--superficie); color: var(--texto-secundario); font: inherit; font-size: 12px; cursor: pointer; }
    .tpl-acoes .del:hover { background: var(--erro-suave); color: var(--erro); border-color: var(--erro); }
    .mais { display: block; margin: var(--espacamento-4) auto 0; padding: var(--espacamento-2) var(--espacamento-4); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--superficie-elevada); color: var(--texto); font: inherit; font-size: 12px; cursor: pointer; }
    button { cursor: pointer; }
    .fora { position: fixed; inset: 0; background: rgba(0,0,0,.3); z-index: 40; }
    .modal { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 41; width: min(520px, 92vw); max-height: 88vh; overflow: auto;
      background: var(--superficie-elevada); border: 1px solid var(--borda); border-radius: var(--raio-painel); box-shadow: var(--elevacao-modal); padding: var(--espacamento-5); display: flex; flex-direction: column; gap: var(--espacamento-3); }
    .m-topo { display: flex; align-items: center; justify-content: space-between; }
    .m-topo h2 { margin: 0; color: var(--texto); }
    .m-x { border: 0; background: transparent; color: var(--texto-secundario); font-size: 16px; }
    .campo { display: flex; flex-direction: column; gap: 4px; }
    .campo span { font-size: 12px; color: var(--texto-secundario); font-weight: 500; }
    .campo small { font-size: 11px; color: var(--texto-suave); }
    .campo input, .campo select, .campo textarea { padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--superficie); color: var(--texto); font: inherit; font-size: 13px; }
    .campo textarea { resize: vertical; }
    .m-acoes { display: flex; justify-content: flex-end; gap: var(--espacamento-2); margin-top: var(--espacamento-2); }
    .cancelar { padding: var(--espacamento-2) var(--espacamento-4); border: 0; background: transparent; color: var(--texto-secundario); font: inherit; }
    .salvar { padding: var(--espacamento-2) var(--espacamento-4); border: 1px solid var(--acao); border-radius: var(--raio-controle); background: var(--acao); color: var(--acao-texto); font: inherit; }
    .salvar:disabled { opacity: .5; }
    @media (max-width: 640px) { :host { padding: var(--espacamento-3); } }
  `,
})
export class TemplatesPagina implements OnInit {
  readonly servico = inject(TemplatesServico)
  readonly rascunho = signal<Rascunho | null>(null)
  readonly erroForm = signal<string | null>(null)
  readonly salvando = signal(false)

  ngOnInit(): void { void this.servico.carregar() }

  rotulo(s: string): string { return ROTULO_STATUS[s] ?? s }

  abrirNovo(): void { this.erroForm.set(null); this.rascunho.set({ ...VAZIO }) }
  abrirEdicao(t: ItemTemplate): void {
    this.erroForm.set(null)
    this.rascunho.set({
      id: t.id, nome: t.nome, categoria: t.categoria,
      header: t.corpo?.header?.texto ?? '', body: t.corpo?.body?.texto ?? '',
      footer: t.corpo?.footer?.texto ?? '', botoes: (t.corpo?.botoes ?? []).map((b) => b.texto).join(', '),
    })
  }
  fechar(): void { this.rascunho.set(null); this.erroForm.set(null) }

  normalizarNome(r: Rascunho): void {
    r.nome = r.nome.toLowerCase().replace(/[^a-z0-9_]/g, '_')
  }

  private montarCorpo(r: Rascunho): CorpoTemplate {
    const corpo: CorpoTemplate = { body: { texto: r.body.trim() } }
    if (r.header.trim()) corpo.header = { texto: r.header.trim() }
    if (r.footer.trim()) corpo.footer = { texto: r.footer.trim() }
    const botoes = r.botoes.split(',').map((b) => b.trim()).filter(Boolean).slice(0, 3)
    if (botoes.length) corpo.botoes = botoes.map((texto) => ({ texto }))
    return corpo
  }

  async salvar(r: Rascunho): Promise<void> {
    this.salvando.set(true); this.erroForm.set(null)
    const corpo = this.montarCorpo(r)
    const erro = r.id ? await this.servico.novaVersao(r.id, corpo) : await this.servico.criar(r.nome.trim(), r.categoria, corpo)
    this.salvando.set(false)
    if (erro) { this.erroForm.set(ERRO_CRIAR[erro] ?? 'Não foi possível salvar.'); return }
    this.fechar()
  }

  async apagar(t: ItemTemplate): Promise<void> { await this.servico.apagar(t.id) }
}
