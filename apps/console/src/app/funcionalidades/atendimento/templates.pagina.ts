import { Component, ChangeDetectionStrategy, computed, inject, signal, OnInit } from '@angular/core'
import { TemplatesServico, type CorpoTemplate, type ItemTemplate } from './templates.servico.js'
import {
  BadgeComponente, CabecalhoTelaComponente, CampoComponente, CelulaDiretiva, ConfirmacaoServico, EstadoComponente,
  IconeComponente, ModalComponente, PaginacaoComponente, SelectComponente, TabelaComponente, ToastServico,
  type ColunaTabela, type LinhaTabela, GradeFormComponente
} from '../../compartilhado/ui/index.js'
import { OPCOES_CAMPO_MAPEAMENTO, mapeamentoParaSalvar, variaveisDoTemplate, variaveisSemCampo } from './templates.regras.js'

interface Rascunho { id: string | null; nome: string; categoria: string; header: string; body: string; footer: string; botoes: string }
const VAZIO: Rascunho = { id: null, nome: '', categoria: 'MARKETING', header: '', body: '', footer: '', botoes: '' }
const ROTULO_STATUS: Record<string, string> = {
  PENDING: 'Aguardando Meta', APPROVED: 'Aprovado', REJECTED: 'Rejeitado', PAUSED: 'Pausado', DISABLED: 'Desabilitado',
}
const TOM_STATUS: Record<string, 'sucesso' | 'atencao' | 'erro' | 'neutro'> = {
  APPROVED: 'sucesso', PENDING: 'atencao', REJECTED: 'erro', PAUSED: 'neutro', DISABLED: 'neutro',
}
const ROTULO_CATEGORIA: Record<string, string> = {
  MARKETING: 'Marketing', UTILITY: 'Utilidade', AUTHENTICATION: 'Autenticação',
}
const OPCOES_CATEGORIA = Object.entries(ROTULO_CATEGORIA).map(([valor, rotulo]) => ({ valor, rotulo }))
const ERRO_CRIAR: Record<string, string> = {
  'nome.invalido': 'Nome inválido: use minúsculas, números e _.',
  'categoria.invalida': 'Escolha uma categoria.',
  'corpo.body_vazio': 'O corpo (body) é obrigatório.',
  'corpo.body_longo': 'O corpo passou de 1024 caracteres.',
  'template.ja_existe': 'Já existe um template com esse nome e idioma.',
}

/**
 * Templates (HSM) — o que reabre a janela de 24h. Catálogo paginado por cursor
 * com status da Meta; criar/editar (nova versão) em modal; mapear variáveis
 * {{n}} para campos do contato em modal de ação; apagar rascunho.
 * ⚠️ A aprovação é da Meta: a tela mostra o status e diz que a submissão ainda não está conectada.
 */
@Component({
  selector: 'app-templates',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GradeFormComponente, 
    BadgeComponente, CabecalhoTelaComponente, CampoComponente, CelulaDiretiva, EstadoComponente, IconeComponente,
    ModalComponente, PaginacaoComponente, SelectComponente, TabelaComponente,
  ],
  template: `
    <ui-cabecalho-tela titulo="Templates (HSM)" subtitulo="Mensagens aprovadas na Meta — o que reabre a janela de 24h.">
      <button type="button" class="btn btn--primario" (click)="abrirNovo()"><ui-icone nome="plus" />Novo template</button>
    </ui-cabecalho-tela>

    <p class="nota"><ui-icone nome="info" />A aprovação vem da Meta. Enquanto o canal oficial não está conectado, o template fica <b>Aguardando Meta</b> — o envio só usa os <b>Aprovados</b>.</p>

    @switch (servico.estado()) {
      @case ('carregando') {
        <ui-tabela [colunas]="colunas" [linhas]="[]" [carregando]="true" />
      }
      @case ('sem_permissao') {
        <ui-estado tipo="sem-permissao" titulo="Você não tem acesso aos templates"
          descricao="Peça a um administrador da sua empresa para liberar este acesso." />
      }
      @case ('erro') {
        <ui-estado tipo="erro" titulo="Não foi possível carregar os templates" descricao="Verifique a conexão e tente de novo.">
          <button type="button" class="btn btn--secundario" (click)="servico.carregar()">Tentar de novo</button>
        </ui-estado>
      }
      @case ('pronto') {
        @if (servico.erro(); as e) { <p class="erro-texto" role="alert">{{ e }}</p> }
        <ui-tabela [colunas]="colunas" [linhas]="linhas()">
          <ng-template uiCelula="nome" let-t>
            <span class="tpl-nome">{{ t.nome }}</span>
            <span class="suave txt-dados">{{ t.idioma }} · v{{ t.versao }}</span>
          </ng-template>
          <ng-template uiCelula="status" let-t>
            <ui-badge [tom]="tomStatus(t.statusMeta)">{{ rotulo(t.statusMeta) }}</ui-badge>
            @if (t.statusMeta === 'REJECTED' && t.motivoRejeicao) {
              <p class="rejeicao"><ui-icone nome="x" [tamanho]="14" />{{ t.motivoRejeicao }}</p>
            }
          </ng-template>
          <ng-template uiCelula="categoria" let-t>{{ rotuloCategoria(t.categoria) }}</ng-template>
          <ng-template uiCelula="corpo" let-t>
            <p class="corpo-previa">
              @if (t.corpo.header?.texto) { <strong>{{ t.corpo.header.texto }}</strong> }
              {{ t.corpo.body.texto }}
              @if (t.corpo.footer?.texto) { <span class="suave"> · {{ t.corpo.footer.texto }}</span> }
            </p>
            @if (t.corpo.botoes?.length) {
              <span class="botoes">
                @for (b of t.corpo.botoes; track $index) { <span class="btn-chip">{{ b.texto }}</span> }
              </span>
            }
          </ng-template>
          <ng-template uiCelula="variaveis" let-t>
            @if (variaveis(t); as vars) {
              @if (vars.length > 0) {
                <span class="tags">
                  <button type="button" class="btn btn--secundario btn--pequeno" (click)="abrirMapa(t)">Mapear ({{ vars.length }})</button>
                  @if (semCampo(t) > 0) { <ui-badge tom="atencao">{{ semCampo(t) }} sem campo</ui-badge> }
                </span>
              } @else {
                <span class="suave">Sem variáveis</span>
              }
            }
          </ng-template>
          <ng-template uiCelula="acoes" let-t>
            <span class="acoes">
              <button type="button" class="btn btn--secundario btn--pequeno" (click)="abrirEdicao(t)">Editar (nova versão)</button>
              @if (!t.submetido) {
                <button type="button" class="btn btn--perigo btn--pequeno" (click)="apagar(t)">Apagar</button>
              }
            </span>
          </ng-template>
          <div uiVazio>
            <ui-estado titulo="Nenhum template ainda"
              descricao="Crie o primeiro — ele nasce como rascunho até a Meta aprovar.">
              <button type="button" class="btn btn--secundario" (click)="abrirNovo()">Novo template</button>
            </ui-estado>
          </div>
        </ui-tabela>
        <ui-paginacao [mostrados]="servico.itens().length" [temMais]="servico.proximoCursor() !== null"
          [carregando]="servico.carregandoMais()" (mais)="servico.carregarMais()" />
      }
    }

    <!-- Criar e editar (nova versão): modal de cadastro. Nome e categoria travam depois de criado. -->
    <ui-modal [aberto]="rascunho() !== null" [titulo]="tituloForm()" largura="m" (fechar)="fechar()">
      @if (rascunho(); as r) {
        @if (erroForm(); as e) { <p class="erro-texto" role="alert">{{ e }}</p> }
        <ui-grade-form>
          <ui-campo rotulo="Nome (identificador na Meta)" placeholder="reposicao_mensal"
            dica="Minúsculas, números e _. Não muda depois de criado." [obrigatorio]="true"
            [desabilitado]="!!r.id" [valor]="r.nome" (valorChange)="setNome($event)" />
          <ui-select rotulo="Categoria" [opcoes]="opcoesCategoria" [valor]="r.categoria"
            [desabilitado]="!!r.id" (valorChange)="atualizar({ categoria: $event })" />
          <ui-campo rotulo="Cabeçalho (opcional)" placeholder="Novidades" [valor]="r.header"
            (valorChange)="atualizar({ header: $event })" />
          <!-- Chaves de variável em atributo estático viram interpolação do Angular: por isso o binding. -->
          <ui-campo tipo="textarea" [largo]="true" rotulo="Corpo" [placeholder]="'Olá {{1}}, chegou reposição do que você compra.'"
            [dica]="'Variáveis posicionais: {{1}}, {{2}}… Até 1024 caracteres.'" [obrigatorio]="true"
            [valor]="r.body" (valorChange)="atualizar({ body: $event })" />
          <ui-campo rotulo="Rodapé (opcional)" placeholder="Sua loja" [valor]="r.footer"
            (valorChange)="atualizar({ footer: $event })" />
          <ui-campo [largo]="true" rotulo="Botões (opcional)" placeholder="Ver ofertas, Falar com vendedor"
            dica="Até 3, separados por vírgula." [valor]="r.botoes" (valorChange)="atualizar({ botoes: $event })" />
        </ui-grade-form>
      }
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="fechar()" [disabled]="salvando()">Cancelar</button>
        <button type="button" class="btn btn--primario" (click)="salvar()"
          [disabled]="salvando() || !(rascunho()?.nome ?? '').trim() || !(rascunho()?.body ?? '').trim()">
          {{ salvando() ? 'Salvando…' : rascunho()?.id ? 'Salvar nova versão' : 'Criar rascunho' }}
        </button>
      </div>
    </ui-modal>

    <!-- Mapeamento {{n}} → campo do contato. Cada escolha salva na hora (como antes). -->
    <ui-modal [aberto]="itemMapeando() !== null" [titulo]="tituloMapa()" largura="p" [sujo]="false" (fechar)="fecharMapa()">
      @if (itemMapeando(); as t) {
        <p class="explica">Escolha de qual campo do contato sai cada variável. Cada escolha é salva na hora.</p>
        @if (erroMapa(); as e) { <p class="erro-texto" role="alert">{{ e }}</p> }
        <div class="campos">
          @for (v of variaveis(t); track v) {
            <ui-select [rotulo]="'Variável {{' + v + '}}'" placeholder="Sem campo" [opcoes]="opcoesCampo"
              [valor]="campoDe(t, v)" (valorChange)="mapear(t, v, $event)" />
          }
        </div>
      }
      <div rodape>
        <button type="button" class="btn btn--primario" (click)="fecharMapa()">Concluir</button>
      </div>
    </ui-modal>
  `,
  styles: `
    :host { display: block; width: 100%; min-width: 0; padding: var(--espacamento-6); }
    ui-cabecalho-tela { display: block; }
    .nota { display: flex; align-items: flex-start; gap: var(--espacamento-2); margin: var(--espacamento-4) 0; padding: var(--espacamento-3);
      border: 1px solid var(--borda); border-radius: var(--raio-controle); background: var(--superficie); color: var(--texto-secundario); font-size: 12px; }
    .nota b { color: var(--texto); font-weight: 600; }
    .erro-texto { margin: 0; color: var(--erro); font-size: 13px; }
    .tpl-nome { display: block; color: var(--texto); font-family: var(--tipografia-familia-dados); font-size: 13px; overflow-wrap: anywhere; }
    .suave { color: var(--texto-suave); }
    .rejeicao { display: flex; align-items: flex-start; gap: var(--espacamento-1); margin: var(--espacamento-1) 0 0; font-size: 12px; color: var(--erro); }
    .corpo-previa { margin: 0; max-width: 46ch; color: var(--texto-secundario); font-size: 13px; white-space: pre-wrap;
      display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .botoes, .tags, .acoes { display: flex; flex-wrap: wrap; gap: var(--espacamento-1); }
    .acoes { justify-content: flex-end; gap: var(--espacamento-2); }
    .btn-chip { font-size: 11px; color: var(--acao); border: 1px solid var(--acao-suave); background: var(--acao-suave); border-radius: var(--raio-controle); padding: 1px 8px; }
    .explica { margin: 0 0 var(--espacamento-3); font-size: 13px; color: var(--texto-secundario); line-height: 1.5; }
    @media (max-width: 640px) { :host { padding: var(--espacamento-3); } }
  `,
})
export class TemplatesPagina implements OnInit {
  readonly servico = inject(TemplatesServico)
  private readonly confirmacao = inject(ConfirmacaoServico)
  private readonly toast = inject(ToastServico)

  protected readonly colunas: ColunaTabela[] = [
    { chave: 'nome', rotulo: 'Template' },
    { chave: 'status', rotulo: 'Status', largura: '200px' },
    { chave: 'categoria', rotulo: 'Categoria', largura: '130px' },
    { chave: 'corpo', rotulo: 'Mensagem' },
    { chave: 'variaveis', rotulo: 'Variáveis', largura: '200px' },
    { chave: 'acoes', rotulo: 'Ações', alinhamento: 'dir', largura: '230px' },
  ]
  protected readonly linhas = computed(() => this.servico.itens() as unknown as readonly LinhaTabela[])
  protected readonly opcoesCategoria = OPCOES_CATEGORIA
  readonly opcoesCampo = OPCOES_CAMPO_MAPEAMENTO

  readonly rascunho = signal<Rascunho | null>(null)
  readonly erroForm = signal<string | null>(null)
  readonly salvando = signal(false)
  /** Template cujas variáveis estão sendo mapeadas; `null` = modal fechado. */
  readonly mapeandoId = signal<string | null>(null)
  readonly itemMapeando = computed(() => {
    const id = this.mapeandoId()
    return id ? (this.servico.itens().find((t) => t.id === id) ?? null) : null
  })
  readonly erroMapa = signal<string | null>(null)

  ngOnInit(): void { void this.servico.carregar() }

  tituloForm(): string { return this.rascunho()?.id ? 'Editar template (nova versão)' : 'Novo template' }
  tituloMapa(): string { return `Variáveis de ${this.itemMapeando()?.nome ?? 'template'}` }

  rotulo(s: string): string { return ROTULO_STATUS[s] ?? s }
  tomStatus(s: string): 'sucesso' | 'atencao' | 'erro' | 'neutro' { return TOM_STATUS[s] ?? 'neutro' }
  rotuloCategoria(c: string): string { return ROTULO_CATEGORIA[c] ?? c }

  /** Variáveis {{n}} do cabeçalho e do corpo (a lista que o editor de mapeamento mostra). */
  variaveis(t: ItemTemplate): number[] { return variaveisDoTemplate(t.corpo) }
  semCampo(t: ItemTemplate): number { return variaveisSemCampo(this.variaveis(t), t.mapeamentoVariaveis ?? {}) }
  campoDe(t: ItemTemplate, v: number): string { return t.mapeamentoVariaveis?.[String(v)] ?? '' }

  abrirMapa(t: ItemTemplate): void { this.erroMapa.set(null); this.mapeandoId.set(t.id) }
  fecharMapa(): void { this.mapeandoId.set(null); this.erroMapa.set(null) }

  /** Escolher o campo salva na hora; vazio remove a variável do mapeamento. */
  async mapear(t: ItemTemplate, v: number, campo: string): Promise<void> {
    if (campo === this.campoDe(t, v)) return
    const escolhas = { ...t.mapeamentoVariaveis, [String(v)]: campo }
    const erro = await this.servico.salvarMapeamento(t.id, mapeamentoParaSalvar(this.variaveis(t), escolhas))
    if (erro) this.erroMapa.set(erro)
    else { this.erroMapa.set(null); this.toast.sucesso('Mapeamento salvo') }
  }

  abrirNovo(): void { this.erroForm.set(null); this.rascunho.set({ ...VAZIO }) }
  abrirEdicao(t: ItemTemplate): void {
    this.erroForm.set(null)
    this.rascunho.set({
      id: t.id, nome: t.nome, categoria: t.categoria,
      header: t.corpo.header?.texto ?? '', body: t.corpo.body.texto,
      footer: t.corpo.footer?.texto ?? '', botoes: (t.corpo.botoes ?? []).map((b) => b.texto).join(', '),
    })
  }
  fechar(): void { if (this.salvando()) return; this.rascunho.set(null); this.erroForm.set(null) }

  atualizar(parcial: Partial<Rascunho>): void {
    this.rascunho.update((r) => (r ? { ...r, ...parcial } : r))
  }

  /** Nome do template: minúsculas, números e _ (normaliza ao digitar). */
  setNome(nome: string): void {
    this.atualizar({ nome: nome.toLowerCase().replace(/[^a-z0-9_]/g, '_') })
  }

  private montarCorpo(r: Rascunho): CorpoTemplate {
    const corpo: CorpoTemplate = { body: { texto: r.body.trim() } }
    if (r.header.trim()) corpo.header = { texto: r.header.trim() }
    if (r.footer.trim()) corpo.footer = { texto: r.footer.trim() }
    const botoes = r.botoes.split(',').map((b) => b.trim()).filter(Boolean).slice(0, 3)
    if (botoes.length) corpo.botoes = botoes.map((texto) => ({ texto }))
    return corpo
  }

  async salvar(): Promise<void> {
    const r = this.rascunho()
    if (!r || this.salvando()) return
    this.salvando.set(true); this.erroForm.set(null)
    const corpo = this.montarCorpo(r)
    const erro = r.id ? await this.servico.novaVersao(r.id, corpo) : await this.servico.criar(r.nome.trim(), r.categoria, corpo)
    this.salvando.set(false)
    if (erro) { this.erroForm.set(ERRO_CRIAR[erro] ?? 'Não foi possível salvar.'); return }
    this.rascunho.set(null); this.erroForm.set(null)
  }

  async apagar(t: ItemTemplate): Promise<void> {
    const ok = await this.confirmacao.confirmar({
      titulo: 'Apagar template?',
      mensagem: `O rascunho "${t.nome}" (v${t.versao}) some. Só rascunhos não enviados à Meta podem ser apagados.`,
      acao: 'Apagar',
    })
    if (!ok) return
    if (await this.servico.apagar(t.id)) this.toast.sucesso('Template apagado')
  }
}
