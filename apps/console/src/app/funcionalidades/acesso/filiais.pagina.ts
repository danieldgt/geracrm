import { HttpErrorResponse } from '@angular/common/http'
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core'
import {
  BadgeComponente, CabecalhoTelaComponente, CampoComponente, CelulaDiretiva, ConfirmacaoServico, EstadoComponente,
  GradeFormComponente, ModalComponente, PaginacaoComponente, SelectComponente, TabelaComponente, ToastServico,
  codigoDoErro, mensagemDeErro, mesclarPagina, type ColunaTabela, type LinhaTabela, type OpcaoSelect,
} from '../../compartilhado/ui/index.js'
import { UFS } from '../crm/contato-form.regras.js'
import { CORES_FILIAL, chaveDoHex, hexDaCor } from './filiais.cores.js'
import {
  ROTULO_TIPO, TIPOS_FILIAL, erroDoNomeFilial, localDaFilial, mapearErroFilial, montarPayloadFilial,
  type CampoFilial, type FilialLista,
} from './filiais.regras.js'
import { FiliaisServico } from './filiais.servico.js'
import { TEXTO_SEM_ADMIN, estadoDaFalhaDeLista } from './usuarios.regras.js'

type EstadoLista = 'carregando' | 'pronto' | 'erro' | 'sem_permissao' | 'sem_admin'
const OPCOES_UF: OpcaoSelect[] = UFS.map((u) => ({ valor: u, rotulo: u }))
const OPCOES_TIPO: OpcaoSelect[] = TIPOS_FILIAL.map((t) => ({ valor: t, rotulo: ROTULO_TIPO[t] }))
const OPCOES_COR: OpcaoSelect[] = CORES_FILIAL.map((c) => ({ valor: c.chave, rotulo: c.rotulo }))
const OPCOES_SITUACAO: OpcaoSelect[] = [{ valor: 'true', rotulo: 'Ativa' }, { valor: 'false', rotulo: 'Inativa' }]

/** Filiais (D3.4) — padrão Lista + CRUD em modal. Desativar não apaga: os usuários mantêm o papel naquela filial. */
@Component({
  selector: 'app-filiais',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    BadgeComponente, CabecalhoTelaComponente, CampoComponente, CelulaDiretiva, EstadoComponente, GradeFormComponente,
    ModalComponente, PaginacaoComponente, SelectComponente, TabelaComponente,
  ],
  template: `
    <ui-cabecalho-tela titulo="Filiais" subtitulo="Matriz e filiais da empresa. O papel de cada usuário vale por filial.">
      <button type="button" class="btn btn--primario" (click)="nova()">+ Nova filial</button>
    </ui-cabecalho-tela>

    <div class="corpo">
      @switch (estado()) {
        @case ('sem_permissao') {
          <ui-estado tipo="sem-permissao" titulo="Sem acesso às filiais" descricao="Peça acesso a um administrador." />
        }
        @case ('sem_admin') {
          <ui-estado tipo="sem-permissao" [titulo]="textoSemAdmin.titulo" [descricao]="textoSemAdmin.descricao" />
        }
        @case ('erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar as filiais" [descricao]="erroLista()">
            <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
          </ui-estado>
        }
        @default {
          <ui-tabela [colunas]="colunas" [linhas]="linhas()" [carregando]="estado() === 'carregando'">
            <ng-template uiCelula="nome" let-f>
              <span class="chip">
                <span class="ponto" aria-hidden="true" [style.background]="f.cor || 'var(--texto-suave)'"></span>{{ f.nome }}
              </span>
            </ng-template>
            <ng-template uiCelula="local" let-f>{{ local(f) }}</ng-template>
            <ng-template uiCelula="tipo" let-f>
              <ui-badge [tom]="f.tipo === 'matriz' ? 'info' : 'neutro'">{{ rotuloTipo(f.tipo) }}</ui-badge>
            </ng-template>
            <ng-template uiCelula="ativa" let-f>
              <ui-badge [tom]="f.ativa ? 'sucesso' : 'neutro'">{{ f.ativa ? 'Ativa' : 'Inativa' }}</ui-badge>
            </ng-template>
            <ng-template uiCelula="acoes" let-f>
              <span class="acoes">
                <button type="button" class="btn btn--secundario btn--pequeno" (click)="editar(f.id)">Editar</button>
                <button type="button" class="btn btn--secundario btn--pequeno" (click)="alternarAtiva(f.id)">
                  {{ f.ativa ? 'Desativar' : 'Ativar' }}
                </button>
              </span>
            </ng-template>
            <div uiVazio>
              <ui-estado titulo="Nenhuma filial ainda"
                descricao="Cadastre a matriz e as filiais para dar papéis por unidade.">
                <button type="button" class="btn btn--primario" (click)="nova()">+ Nova filial</button>
              </ui-estado>
            </div>
          </ui-tabela>
          @if (estado() === 'pronto') {
            <ui-paginacao [mostrados]="itens().length" [temMais]="cursor() !== null"
              [carregando]="carregandoMais()" (mais)="carregarMais()" />
          }
        }
      }
    </div>

    <ui-modal [aberto]="edicao() !== null" [titulo]="edicao()?.id ? 'Editar filial' : 'Nova filial'" largura="m" (fechar)="fechar()">
      <form id="form-filial" (submit)="salvar($event)">
        <ui-grade-form [colunas]="2">
          <ui-campo class="largo" rotulo="Nome" [obrigatorio]="true" [(valor)]="nome" [erro]="erros().nome ?? null" />
          <ui-campo rotulo="Cidade" [(valor)]="cidade" />
          <ui-select rotulo="UF" placeholder="—" [opcoes]="opcoesUf" [(valor)]="uf" [erro]="erros().uf ?? null" />
          <ui-select rotulo="Tipo" [opcoes]="opcoesTipo" [(valor)]="tipo" [erro]="erros().tipo ?? null" />
          <div class="cor-linha">
            <ui-select rotulo="Cor de identificação" placeholder="Sem cor" [opcoes]="opcoesCor" [(valor)]="cor"
              [erro]="erros().cor ?? null" />
            @if (hexAmostra(); as h) { <span class="amostra" aria-hidden="true" [style.background]="h"></span> }
          </div>
          <ui-select rotulo="Situação" [opcoes]="opcoesSituacao" [(valor)]="ativa" [erro]="erros().ativa ?? null" />
        </ui-grade-form>
        @if (erroEnvio(); as e) { <p class="erro-envio" role="alert">{{ e }}</p> }
      </form>
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="fechar()">Cancelar</button>
        <button type="submit" form="form-filial" class="btn btn--primario" [disabled]="salvando()">
          {{ salvando() ? 'Salvando…' : 'Salvar' }}
        </button>
      </div>
    </ui-modal>
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .corpo { margin-top: var(--espacamento-4); display: grid; gap: var(--espacamento-2); min-width: 0; }
    ui-tabela { display: block; }
    .chip { display: inline-flex; align-items: center; gap: var(--espacamento-2); }
    .ponto { width: 10px; height: 10px; border-radius: var(--raio-completo); flex: none; }
    .acoes { display: inline-flex; gap: var(--espacamento-2); }
    .cor-linha { display: flex; align-items: end; gap: var(--espacamento-3); min-width: 0; }
    .cor-linha ui-select { flex: 1; min-width: 0; }
    .amostra { width: 36px; height: 36px; border-radius: var(--raio-controle); border: 1px solid var(--borda); flex: none; }
    .erro-envio { margin: var(--espacamento-3) 0 0; color: var(--erro); font-size: 13px; }
  `,
})
export class FiliaisPagina implements OnInit {
  private readonly api = inject(FiliaisServico)
  private readonly toast = inject(ToastServico)
  private readonly confirmacao = inject(ConfirmacaoServico)

  protected readonly colunas: ColunaTabela[] = [
    { chave: 'nome', rotulo: 'Filial' },
    { chave: 'local', rotulo: 'Cidade/UF', largura: '180px' },
    { chave: 'tipo', rotulo: 'Tipo', largura: '110px' },
    { chave: 'usuarios', rotulo: 'Usuários', mono: true, largura: '100px' },
    { chave: 'ativa', rotulo: 'Situação', largura: '110px' },
    { chave: 'acoes', rotulo: 'Ações', alinhamento: 'dir', largura: '200px' },
  ]
  protected readonly opcoesUf = OPCOES_UF
  protected readonly opcoesTipo = OPCOES_TIPO
  protected readonly opcoesCor = OPCOES_COR
  protected readonly opcoesSituacao = OPCOES_SITUACAO
  protected readonly textoSemAdmin = TEXTO_SEM_ADMIN

  protected readonly estado = signal<EstadoLista>('carregando')
  protected readonly erroLista = signal('')
  protected readonly itens = signal<readonly FilialLista[]>([])
  protected readonly linhas = computed(() => this.itens() as unknown as readonly LinhaTabela[])
  protected readonly cursor = signal<string | null>(null)
  protected readonly carregandoMais = signal(false)

  protected readonly edicao = signal<{ id: string | null } | null>(null)
  protected readonly nome = signal('')
  protected readonly cidade = signal('')
  protected readonly uf = signal('')
  protected readonly tipo = signal('filial')
  protected readonly cor = signal('')
  protected readonly ativa = signal('true')
  protected readonly erros = signal<Partial<Record<CampoFilial, string>>>({})
  protected readonly erroEnvio = signal<string | null>(null)
  protected readonly salvando = signal(false)
  protected readonly hexAmostra = computed(() => hexDaCor(this.cor()))

  ngOnInit(): void { void this.carregar() }

  protected local = localDaFilial
  protected rotuloTipo(t: string): string { return ROTULO_TIPO[t as keyof typeof ROTULO_TIPO] ?? t }

  protected async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await this.api.listar(null)
      this.itens.set(r.itens)
      this.cursor.set(r.proximoCursor)
      this.estado.set('pronto')
    } catch (e) {
      const falha = estadoDaFalhaDeLista(e instanceof HttpErrorResponse ? e.status : 0, codigoDoErro(e))
      if (falha === 'erro') this.erroLista.set(mensagemDeErro(e, 'Verifique a conexão e tente de novo.'))
      this.estado.set(falha)
    }
  }

  protected async carregarMais(): Promise<void> {
    const c = this.cursor()
    if (!c || this.carregandoMais()) return
    this.carregandoMais.set(true)
    try {
      const r = await this.api.listar(c)
      this.itens.update((atual) => mesclarPagina(atual, r.itens, (f) => f.id))
      this.cursor.set(r.proximoCursor)
    } catch (e) {
      this.toast.erro(mensagemDeErro(e, 'Não foi possível carregar mais filiais.'))
    } finally { this.carregandoMais.set(false) }
  }

  protected nova(): void {
    this.preencher({ nome: '', cidade: '', uf: '', tipo: 'filial', cor: '', ativa: 'true' })
    this.edicao.set({ id: null })
  }

  protected editar(id: string): void {
    const f = this.itens().find((x) => x.id === id)
    if (!f) return
    this.preencher({
      nome: f.nome, cidade: f.cidade ?? '', uf: f.uf ?? '', tipo: f.tipo, cor: chaveDoHex(f.cor), ativa: String(f.ativa),
    })
    this.edicao.set({ id })
  }

  private preencher(v: { nome: string; cidade: string; uf: string; tipo: string; cor: string; ativa: string }): void {
    this.nome.set(v.nome); this.cidade.set(v.cidade); this.uf.set(v.uf); this.tipo.set(v.tipo)
    this.cor.set(v.cor); this.ativa.set(v.ativa)
    this.erros.set({}); this.erroEnvio.set(null)
  }

  protected fechar(): void { if (!this.salvando()) this.edicao.set(null) }

  protected async salvar(ev: Event): Promise<void> {
    ev.preventDefault()
    const ed = this.edicao()
    if (!ed || this.salvando()) return
    const erroNome = erroDoNomeFilial(this.nome())
    this.erros.set(erroNome ? { nome: erroNome } : {})
    if (erroNome) return
    this.salvando.set(true); this.erroEnvio.set(null)
    const corpo = montarPayloadFilial(
      { nome: this.nome(), cidade: this.cidade(), uf: this.uf(), tipo: this.tipo(), cor: this.cor(), ativa: this.ativa() === 'true' },
      hexDaCor,
    )
    try {
      if (ed.id) await this.api.editar(ed.id, corpo)
      else await this.api.criar(corpo)
      this.edicao.set(null)
      this.toast.sucesso(ed.id ? 'Alterações salvas.' : 'Filial criada.')
      await this.carregar()
    } catch (err) {
      const m = mapearErroFilial(codigoDoErro(err))
      if (m?.campo) this.erros.set({ [m.campo]: m.mensagem })
      else this.erroEnvio.set(m?.mensagem ?? mensagemDeErro(err, 'Não foi possível salvar.'))
    } finally { this.salvando.set(false) }
  }

  protected async alternarAtiva(id: string): Promise<void> {
    const f = this.itens().find((x) => x.id === id)
    if (!f) return
    if (f.ativa) {
      const ok = await this.confirmacao.confirmar({
        titulo: `Desativar ${f.nome}?`,
        mensagem: f.usuarios > 0
          ? `${f.usuarios} usuário(s) têm papel nesta filial e o mantêm, mas ela deixa de aparecer para novas escolhas.`
          : 'A filial deixa de aparecer para novas escolhas. Dá para reativar depois.',
        acao: 'Desativar', perigo: true,
      })
      if (!ok) return
    }
    try {
      await this.api.editar(id, { ativa: !f.ativa })
      await this.carregar()
    } catch (err) {
      this.toast.erro(mapearErroFilial(codigoDoErro(err))?.mensagem ?? mensagemDeErro(err, 'Não foi possível alterar.'))
    }
  }
}
