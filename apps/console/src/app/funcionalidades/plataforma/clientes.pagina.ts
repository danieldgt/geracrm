import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core'
import { DatePipe } from '@angular/common'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

interface Cliente {
  readonly id: string
  readonly nome: string
  readonly fuso: string
  readonly ativo: boolean
  readonly criadoEm: string
  readonly plano: string
}
interface ModeloFunil {
  readonly codigo: string
  readonly nome: string
  readonly descricao: string
  readonly etapas: readonly { readonly nome: string; readonly tipo: string }[]
}
interface Opcoes {
  readonly planos: readonly { readonly codigo: string; readonly nome: string }[]
  readonly verticais: readonly { readonly codigo: string; readonly nome: string }[]
  readonly modelosFunil: readonly ModeloFunil[]
  readonly podeCriarLogin: boolean
}
interface Criado {
  readonly id: string
  readonly nome: string
  readonly login: { criado: boolean; email?: string; senha?: string; erro?: string }
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * Cadastro de clientes (staff do drezz). Cria a empresa já com o funil montado
 * no modelo do negócio dela, e opcionalmente o primeiro login.
 *
 * ⚠️ A senha inicial aparece UMA vez, no retorno da criação — como o segredo do
 * webhook. Não há como buscá-la depois; se perder, o caminho é redefinir.
 */
@Component({
  selector: 'app-clientes-plataforma',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe],
  template: `
    <header class="cabecalho">
      <h1 class="txt-titulo">Clientes</h1>
      <p class="sub">As empresas que usam o sistema. Cadastrar aqui já monta o funil e o acesso.</p>
    </header>

    @if (opcoes(); as o) {
      @if (!o.podeCriarLogin) {
        <p class="aviso-login" role="status">
          Esta API não está configurada para criar logins — dá para cadastrar a empresa,
          mas o acesso terá de ser criado à parte.
        </p>
      }
    }

    @if (criado(); as c) {
      <section class="painel novo" role="status">
        <h2 class="txt-secao">{{ c.nome }} foi criada</h2>
        @if (c.login.criado) {
          <p class="novo-dica">⚠️ Anote a senha agora — ela não aparece de novo.</p>
          <dl class="credenciais">
            <div><dt>Acesso</dt><dd class="txt-dados">{{ c.login.email }}</dd></div>
            <div><dt>Senha inicial</dt><dd class="txt-dados senha">{{ c.login.senha }}</dd></div>
          </dl>
        } @else if (c.login.erro) {
          <p class="novo-erro">A empresa foi criada, mas o login não: {{ c.login.erro }}</p>
        } @else {
          <p class="novo-dica">Sem login por enquanto — cadastre o acesso quando quiser.</p>
        }
        <button class="btn btn--secundario" (click)="criado.set(null)">Fechar</button>
      </section>
    }

    <form class="painel form" (submit)="cadastrar($event)">
      <h2 class="txt-secao">Nova empresa</h2>
      <div class="grade">
        <label class="campo rotulado">
          <span>Nome da empresa</span>
          <input [value]="nome()" (input)="nome.set(valor($event))" placeholder="Confecção Exemplo Ltda" />
        </label>
        <label class="campo rotulado">
          <span>Plano</span>
          <select [value]="plano()" (change)="plano.set(valor($event))">
            <option value="">Escolha…</option>
            @for (p of opcoes()?.planos ?? []; track p.codigo) {
              <option [value]="p.codigo">{{ p.nome }}</option>
            }
          </select>
        </label>
        <label class="campo rotulado">
          <span>Perfil de vertical</span>
          <select [value]="vertical()" (change)="vertical.set(valor($event))">
            <option value="">Escolha…</option>
            @for (v of opcoes()?.verticais ?? []; track v.codigo) {
              <option [value]="v.codigo">{{ v.nome }}</option>
            }
          </select>
        </label>
        <label class="campo rotulado">
          <span>Modelo de funil</span>
          <select [value]="modelo()" (change)="modelo.set(valor($event))">
            @for (m of opcoes()?.modelosFunil ?? []; track m.codigo) {
              <option [value]="m.codigo">{{ m.nome }}</option>
            }
          </select>
        </label>
      </div>

      @if (modeloEscolhido(); as m) {
        <p class="preview-dica">{{ m.descricao }}</p>
        <div class="preview">
          @for (e of m.etapas; track e.nome) {
            <span class="raia" [class]="'raia--' + e.tipo">{{ e.nome }}</span>
          }
        </div>
      }

      <h3 class="txt-rotulo bloco-sub">Primeiro acesso <span class="opcional">(opcional)</span></h3>
      <div class="grade">
        <label class="campo rotulado">
          <span>Nome de quem vai acessar</span>
          <input [value]="adminNome()" (input)="adminNome.set(valor($event))" placeholder="Maria Silva" />
        </label>
        <label class="campo rotulado">
          <span>E-mail</span>
          <input [value]="adminEmail()" (input)="adminEmail.set(valor($event))"
                 type="email" inputmode="email" placeholder="maria@confeccao.com.br" />
        </label>
      </div>
      <p class="dica-email">
        ⚠️ O e-mail fica preso à empresa para sempre — o vínculo não pode ser alterado depois.
      </p>

      @if (erroForm(); as e) { <p class="erro-add" role="alert">{{ e }}</p> }
      <button class="btn btn--primario" type="submit" [disabled]="salvando() || !podeEnviar()">
        {{ salvando() ? 'Cadastrando…' : 'Cadastrar empresa' }}
      </button>
    </form>

    @switch (estado()) {
      @case ('carregando') { <div class="painel"><div class="esqueleto"></div><div class="esqueleto"></div></div> }
      @case ('sem_permissao') {
        <div class="painel aviso"><h2 class="txt-secao">Esta área é do staff</h2>
          <p>Seu usuário não está no grupo que administra clientes.</p></div>
      }
      @case ('erro') {
        <div class="painel aviso"><h2 class="txt-secao">Não foi possível carregar</h2>
          <button class="btn btn--secundario" (click)="carregar()">Tentar de novo</button></div>
      }
      @case ('pronto') {
        @if (itens().length === 0) {
          <div class="painel vazio"><h2 class="txt-secao">Nenhuma empresa ainda</h2>
            <p>A primeira empresa cadastrada aparece aqui.</p></div>
        } @else {
          <ul class="lista">
            @for (c of itens(); track c.id) {
              <li class="item">
                <span class="c-nome encolhe">{{ c.nome }}</span>
                <span class="c-plano">{{ c.plano }}</span>
                <span class="c-data txt-dados">{{ c.criadoEm | date: 'dd/MM/yyyy' }}</span>
                <span class="c-estado" [class.c-estado--off]="!c.ativo">{{ c.ativo ? 'Ativa' : 'Inativa' }}</span>
              </li>
            }
          </ul>
        }
      }
    }
  `,
  styles: `
    :host { display: block; max-width: var(--largura-forma); margin: 0 auto; padding: var(--espacamento-6); }
    .cabecalho { margin-bottom: var(--espacamento-5); }
    h1 { margin: 0; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .painel { padding: var(--espacamento-5); border: 1px solid var(--borda); border-radius: var(--raio-painel);
      background: var(--superficie-elevada); margin-bottom: var(--espacamento-4); }
    .painel h2 { margin: 0 0 var(--espacamento-4); color: var(--texto); }
    .aviso-login { margin: 0 0 var(--espacamento-4); padding: var(--espacamento-3);
      border-radius: var(--raio-controle); background: var(--atencao-suave); color: var(--atencao); font-size: 13px; }
    .novo { border-color: var(--sucesso); }
    .novo-dica { margin: 0 0 var(--espacamento-3); color: var(--texto-secundario); font-size: 13px; }
    .novo-erro { margin: 0 0 var(--espacamento-3); color: var(--erro); font-size: 13px; }
    .credenciais { display: flex; flex-wrap: wrap; gap: var(--espacamento-5); margin: 0 0 var(--espacamento-4); }
    .credenciais dt { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--texto-suave); }
    .credenciais dd { margin: 2px 0 0; color: var(--texto); font-size: 14px; }
    .senha { padding: 2px 8px; border-radius: var(--raio-controle); background: var(--fundo); user-select: all; }
    .grade { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--espacamento-3); }
    .campo.rotulado { display: flex; flex-direction: column; gap: var(--espacamento-1); }
    .campo.rotulado > span { font-size: 12px; color: var(--texto-secundario); }
    .campo.rotulado input, .campo.rotulado select { padding: var(--espacamento-2) var(--espacamento-3);
      border: 1px solid var(--borda-controle); border-radius: var(--raio-controle);
      background: var(--superficie); color: var(--texto); font: inherit; font-size: 14px; }
    .bloco-sub { display: block; margin: var(--espacamento-5) 0 var(--espacamento-2); color: var(--texto); }
    .opcional { color: var(--texto-suave); font-weight: 400; }
    .dica-email { margin: var(--espacamento-2) 0 0; color: var(--texto-suave); font-size: 12px; }
    .preview-dica { margin: var(--espacamento-3) 0 var(--espacamento-2); color: var(--texto-secundario); font-size: 12px; }
    .preview { display: flex; flex-wrap: wrap; gap: var(--espacamento-2); }
    .raia { font-size: 12px; padding: 2px 10px; border-radius: var(--raio-completo);
      border: 1px solid var(--borda); color: var(--texto-secundario); background: var(--superficie); }
    .raia--ganho { border-color: transparent; background: var(--sucesso-suave); color: var(--sucesso); }
    .raia--perdido { border-color: transparent; background: var(--erro-suave); color: var(--erro); }
    .erro-add { margin: var(--espacamento-3) 0 0; color: var(--erro); font-size: 13px; }
    .form button[type='submit'] { margin-top: var(--espacamento-4); }
    .esqueleto { height: 18px; border-radius: var(--raio-controle); background: var(--superficie);
      margin-bottom: var(--espacamento-2); }
    .aviso, .vazio { text-align: center; }
    .aviso p, .vazio p { color: var(--texto-secundario); font-size: 13px; }
    .lista { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--espacamento-2); }
    .item { display: flex; align-items: center; gap: var(--espacamento-3); padding: var(--espacamento-3);
      border: 1px solid var(--borda); border-radius: var(--raio-controle); background: var(--superficie-elevada); }
    .c-nome { flex: 1; min-width: 0; color: var(--texto); font-size: 14px; }
    .c-plano { font-size: 12px; color: var(--texto-suave); }
    .c-data { font-size: 12px; color: var(--texto-secundario); }
    .c-estado { font-size: 11px; padding: 2px 8px; border-radius: var(--raio-completo);
      background: var(--sucesso-suave); color: var(--sucesso); }
    .c-estado--off { background: var(--fundo); color: var(--texto-suave); }
  `,
})
export class ClientesPlataformaPagina implements OnInit {
  private readonly http = inject(HttpClient)

  readonly estado = signal<Estado>('carregando')
  readonly itens = signal<readonly Cliente[]>([])
  readonly opcoes = signal<Opcoes | null>(null)
  readonly criado = signal<Criado | null>(null)
  readonly salvando = signal(false)
  readonly erroForm = signal<string | null>(null)

  readonly nome = signal('')
  readonly plano = signal('')
  readonly vertical = signal('')
  readonly modelo = signal('crm-recompra')
  readonly adminNome = signal('')
  readonly adminEmail = signal('')

  ngOnInit(): void { void this.carregar() }

  valor(ev: Event): string { return (ev.target as HTMLInputElement | HTMLSelectElement).value }

  modeloEscolhido(): ModeloFunil | undefined {
    return this.opcoes()?.modelosFunil.find((m) => m.codigo === this.modelo())
  }

  podeEnviar(): boolean {
    return Boolean(this.nome().trim() && this.plano() && this.vertical())
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const [lista, ops] = await Promise.all([
        firstValueFrom(this.http.get<{ itens: Cliente[] }>('/v1/plataforma/clientes')),
        firstValueFrom(this.http.get<Opcoes>('/v1/plataforma/opcoes')),
      ])
      this.itens.set(lista.itens)
      this.opcoes.set(ops)
      this.estado.set('pronto')
    } catch (e) {
      this.estado.set(e instanceof HttpErrorResponse && (e.status === 403 || e.status === 401) ? 'sem_permissao' : 'erro')
    }
  }

  async cadastrar(ev: Event): Promise<void> {
    ev.preventDefault()
    if (!this.podeEnviar() || this.salvando()) return
    this.salvando.set(true)
    this.erroForm.set(null)
    try {
      const email = this.adminEmail().trim()
      const r = await firstValueFrom(this.http.post<Criado>('/v1/plataforma/clientes', {
        nome: this.nome().trim(),
        planoCodigo: this.plano(),
        verticalCodigo: this.vertical(),
        modeloFunil: this.modelo(),
        ...(email ? { admin: { nome: this.adminNome().trim(), email } } : {}),
      }))
      this.criado.set(r)
      this.nome.set(''); this.adminNome.set(''); this.adminEmail.set('')
      await this.carregar()
    } catch (e) {
      const corpo = e instanceof HttpErrorResponse ? (e.error as { mensagem?: string }) : null
      this.erroForm.set(corpo?.mensagem ?? 'Não foi possível cadastrar a empresa.')
    } finally {
      this.salvando.set(false)
    }
  }
}
