import { Component, ChangeDetectionStrategy, input, output, signal } from '@angular/core'
import type { CampoCredencial, EsquemaCredencial } from './tipos.js'

/**
 * O formulário de credencial, desenhado a partir do esquema que o conector
 * DECLARA.
 *
 * ⚠️ Não existe `@if (conector === 'geracloud')` aqui, e não pode existir. O
 * GeraCloud pede usuário e senha; o próximo ERP pede token; o seguinte vai
 * pedir também um id de loja. Com o `if`, cada ERP novo é um commit no console
 * — e o console não conhece ERP nenhum (ADR-008).
 */
@Component({
  selector: 'app-formulario-credencial',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (esquema().preRequisito; as pre) {
      <!-- ⚠️ Antes dos campos, não depois: quem chega aqui sem o token
           precisa saber ANTES de tentar preencher. -->
      <p class="pre-requisito">{{ pre }}</p>
    }

    <div class="campos">
      @for (campo of esquema().campos; track campo.nome) {
        <label class="campo" [class.campo--erro]="erroDe(campo.nome)">
          <span class="rotulo">
            {{ campo.rotulo }}
            @if (!campo.obrigatorio) { <span class="opcional">(opcional)</span> }
          </span>

          <span class="entrada">
            <input
              [type]="tipoHtml(campo)"
              [value]="valores()[campo.nome] ?? ''"
              [attr.placeholder]="campo.exemplo ?? null"
              [attr.aria-invalid]="erroDe(campo.nome) ? 'true' : null"
              [attr.aria-describedby]="campo.nome + '-ajuda'"
              [attr.autocomplete]="autocomplete(campo)"
              (input)="digitou(campo.nome, $event)"
            />
            @if (campo.tipo === 'senha') {
              <!-- ⚠️ Revelar é opção de quem digita, e nunca o padrão: a tela
                   fica aberta em balcão de loja, à vista do cliente. -->
              <button type="button" class="revelar"
                      [attr.aria-pressed]="revelados().has(campo.nome)"
                      (click)="alternarRevelacao(campo.nome)">
                {{ revelados().has(campo.nome) ? 'Ocultar' : 'Mostrar' }}
              </button>
            }
          </span>

          <span class="ajuda" [id]="campo.nome + '-ajuda'">
            @if (erroDe(campo.nome); as erro) {
              <span class="erro">{{ erro }}</span>
            } @else if (campo.ajuda) {
              {{ campo.ajuda }}
            }
          </span>
        </label>
      }
    </div>
  `,
  styles: `
    .pre-requisito {
      margin: 0 0 var(--espacamento-4);
      padding: var(--espacamento-3);
      border-left: 3px solid var(--acao);
      background: var(--superficie);
      border-radius: var(--raio-controle);
      color: var(--texto-secundario);
      font-size: var(--tipografia-escala-corpo-tamanho, 14px);
      line-height: 1.5;
    }
    .campos { display: grid; gap: var(--espacamento-4); }
    .campo { display: grid; gap: var(--espacamento-1); }
    .rotulo { font-weight: 500; color: var(--texto); font-size: 13px; }
    .opcional { color: var(--texto-suave); font-weight: 400; }
    .entrada { display: flex; gap: var(--espacamento-2); }
    input {
      flex: 1; min-width: 0;
      padding: var(--espacamento-2) var(--espacamento-3);
      border: 1px solid var(--borda-controle);
      border-radius: var(--raio-controle);
      background: var(--fundo); color: var(--texto);
      font: inherit;
    }
    input:focus-visible {
      outline: 2px solid var(--borda-foco);
      outline-offset: 2px;
      border-color: var(--borda-foco);
    }
    .campo--erro input { border-color: var(--borda-erro); }
    .revelar {
      padding: 0 var(--espacamento-3);
      border: 1px solid var(--borda-controle);
      border-radius: var(--raio-controle);
      background: var(--superficie); color: var(--texto-secundario);
      font: inherit; cursor: pointer;
    }
    .revelar:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
    .ajuda { font-size: 12px; color: var(--texto-suave); line-height: 1.4; min-height: 1em; }
    .erro { color: var(--erro); }
  `,
})
export class FormularioCredencialComponente {
  readonly esquema = input.required<EsquemaCredencial>()
  readonly erros = input<Readonly<Record<string, string>>>({})
  readonly mudou = output<Record<string, string>>()

  readonly valores = signal<Record<string, string>>({})
  readonly revelados = signal<ReadonlySet<string>>(new Set())

  /** ⚠️ Método, não `computed` devolvendo função: no template, `erroDe(x)`
   *  sobre um computed exigiria `erroDe()(x)` — e o erro só aparece na
   *  compilação do template, nunca no `tsc --noEmit`. */
  erroDe(nome: string): string | undefined {
    return this.erros()[nome]
  }

  tipoHtml(campo: CampoCredencial): string {
    if (campo.tipo === 'senha') return this.revelados().has(campo.nome) ? 'text' : 'password'
    return campo.tipo === 'url' ? 'url' : 'text'
  }

  /**
   * ⚠️ `off` em tudo, e `new-password` na senha. Sem isso o navegador oferece
   * as credenciais PESSOAIS de quem está configurando — e alguém acaba salvando
   * o login do GeraCRM como se fosse o do ERP, com um erro que não explica nada.
   */
  autocomplete(campo: CampoCredencial): string {
    return campo.tipo === 'senha' ? 'new-password' : 'off'
  }

  alternarRevelacao(nome: string): void {
    this.revelados.update((s) => {
      const proximo = new Set(s)
      if (proximo.has(nome)) proximo.delete(nome)
      else proximo.add(nome)
      return proximo
    })
  }

  digitou(nome: string, evento: Event): void {
    const valor = (evento.target as HTMLInputElement).value
    this.valores.update((v) => ({ ...v, [nome]: valor }))
    this.mudou.emit(this.valores())
  }
}
