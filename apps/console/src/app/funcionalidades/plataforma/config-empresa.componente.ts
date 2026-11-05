import { ChangeDetectionStrategy, Component, inject, input, output, signal, effect } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { UFS } from '@geracrm/shared'
import {
  CampoComponente, GradeFormComponente, PainelComponente, SelectComponente, ToastServico, focarPrimeiroInvalido, type OpcaoSelect,
} from '../../compartilhado/ui/index.js'
import { mensagemFalhaAoSalvar } from './config.regras.js'
import {
  corpoDaEmpresa, errosDoCorpo, errosDoServidor, formDaEmpresa, resumoDosErros, type EmpresaForm, type EmpresaLida, type ErrosForm,
} from './empresa.regras.js'

const FUSOS = ['America/Sao_Paulo', 'America/Recife', 'America/Manaus', 'America/Cuiaba', 'America/Belem', 'America/Fortaleza', 'America/Rio_Branco']
const OPCOES_UF: OpcaoSelect[] = UFS.map((u) => ({ valor: u, rotulo: u }))

/**
 * Painel EMPRESA das Configurações (D5): nome, CNPJ, contato, endereço e fuso;
 * plano só leitura. Salvar é por painel e SÓ de admin (leitura para os demais).
 * ⚠️ Preserva o que foi digitado em qualquer falha; 422 vai para o campo.
 */
@Component({
  selector: 'app-config-empresa',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CampoComponente, GradeFormComponente, PainelComponente, SelectComponente],
  template: `
    <ui-painel>
      <h2 class="txt-secao">Empresa</h2>
      <p class="dica txt-corpo">Como a empresa aparece para o cliente e nos documentos.</p>
      <form (submit)="salvar($event)" novalidate>
        <ui-grade-form [colunas]="3">
          <ui-campo class="largo" rotulo="Nome" [obrigatorio]="true" [valor]="form().nome" [erro]="erros()['nome'] ?? null"
                    [desabilitado]="leitura()" (valorChange)="mudar('nome', $event)" />
          <ui-campo rotulo="CNPJ" mascara="cnpj" [valor]="form().cnpj" [erro]="erros()['cnpj'] ?? null"
                    [desabilitado]="leitura()" (valorChange)="mudar('cnpj', $event)" />
          <ui-campo rotulo="Telefone" mascara="telefone" tipo="tel" [valor]="form().telefone" [erro]="erros()['telefone'] ?? null"
                    [desabilitado]="leitura()" (valorChange)="mudar('telefone', $event)" />
          <ui-campo rotulo="WhatsApp" mascara="telefone" tipo="tel" [valor]="form().whatsapp" [erro]="erros()['whatsapp'] ?? null"
                    [desabilitado]="leitura()" (valorChange)="mudar('whatsapp', $event)" />
          <ui-campo rotulo="E-mail" tipo="email" [valor]="form().email" [erro]="erros()['email'] ?? null"
                    [desabilitado]="leitura()" (valorChange)="mudar('email', $event)" />
          <ui-campo rotulo="Site" [valor]="form().site" placeholder="https://" [erro]="erros()['site'] ?? null"
                    [desabilitado]="leitura()" (valorChange)="mudar('site', $event)" />
          <ui-select rotulo="Fuso horário" [valor]="form().fuso" [opcoes]="fusos" placeholder="Selecione" [erro]="erros()['fuso'] ?? null"
                     [desabilitado]="leitura()" (valorChange)="mudar('fuso', $event)" />
          <ui-campo rotulo="CEP" mascara="cep" [valor]="form().cep" [erro]="erros()['endereco.cep'] ?? null"
                    [desabilitado]="leitura()" (valorChange)="mudar('cep', $event)" />
          <ui-campo rotulo="Logradouro" [valor]="form().logradouro" [erro]="erros()['endereco.logradouro'] ?? null"
                    [desabilitado]="leitura()" (valorChange)="mudar('logradouro', $event)" />
          <ui-campo rotulo="Número" [valor]="form().numero" [erro]="erros()['endereco.numero'] ?? null"
                    [desabilitado]="leitura()" (valorChange)="mudar('numero', $event)" />
          <ui-campo rotulo="Complemento" [valor]="form().complemento" [erro]="erros()['endereco.complemento'] ?? null"
                    [desabilitado]="leitura()" (valorChange)="mudar('complemento', $event)" />
          <ui-campo rotulo="Bairro" [valor]="form().bairro" [erro]="erros()['endereco.bairro'] ?? null"
                    [desabilitado]="leitura()" (valorChange)="mudar('bairro', $event)" />
          <ui-campo rotulo="Cidade" [valor]="form().cidade" [erro]="erros()['endereco.cidade'] ?? null"
                    [desabilitado]="leitura()" (valorChange)="mudar('cidade', $event)" />
          <ui-select rotulo="UF" [valor]="form().uf" [opcoes]="ufs" placeholder="UF" [erro]="erros()['endereco.uf'] ?? null"
                     [desabilitado]="leitura()" (valorChange)="mudar('uf', $event)" />
          <div class="plano">
            <span class="txt-rotulo">Plano</span>
            <span class="txt-corpo">{{ empresa().plano }}</span>
          </div>
        </ui-grade-form>
        @if (!leitura()) {
          <div class="acoes">
            <button class="btn btn--primario" type="submit" [disabled]="salvando()">{{ salvando() ? 'Salvando…' : 'Salvar empresa' }}</button>
            <!-- Erro fica no painel, ao lado do botão (nunca só num toast que some). -->
            @if (erroGeral(); as e) { <span class="erro txt-denso" role="alert">{{ e }}</span> }
          </div>
        }
      </form>
    </ui-painel>
  `,
  styles: `
    :host { display: block; margin-bottom: var(--espacamento-4); }
    h2 { margin: 0 0 var(--espacamento-1); }
    .dica { margin: 0 0 var(--espacamento-4); color: var(--texto-secundario); }
    .plano { display: flex; flex-direction: column; gap: var(--espacamento-1); justify-content: flex-end; min-width: 0; }
    .acoes { display: flex; align-items: center; flex-wrap: wrap; gap: var(--espacamento-3); margin-top: var(--espacamento-4); }
    .erro { color: var(--erro); }
  `,
})
export class ConfigEmpresaComponente {
  private readonly http = inject(HttpClient)
  private readonly toast = inject(ToastServico)

  readonly empresa = input.required<EmpresaLida>()
  readonly leitura = input(true)
  /** Emite a empresa como o servidor ficou, para a página atualizar o espelho. */
  readonly salvou = output<Partial<EmpresaLida>>()

  readonly fusos: OpcaoSelect[] = FUSOS.map((f) => ({ valor: f, rotulo: f }))
  readonly ufs = OPCOES_UF
  readonly form = signal<EmpresaForm>(formDaEmpresa({} as EmpresaLida))
  readonly erros = signal<ErrosForm>({})
  readonly salvando = signal(false)
  /** Falha ao salvar: inline no painel. O resumo dos campos com erro, ou a mensagem da API. */
  readonly erroGeral = signal<string | null>(null)
  #marca = ''

  constructor() {
    // O formulário nasce (e renasce) do que o servidor tem; o que a pessoa digita vive nele até salvar.
    // ⚠️ Só reage a mudança dos campos DESTE painel: salvar o painel de LGPD também atualiza a empresa
    // da página, e isso não pode apagar o que a pessoa digitou aqui.
    effect(() => {
      const base = formDaEmpresa(this.empresa())
      const marca = JSON.stringify(base)
      if (marca === this.#marca) return
      this.#marca = marca
      this.form.set(base)
    })
  }

  mudar(campo: keyof EmpresaForm, valor: string): void {
    this.form.update((f) => ({ ...f, [campo]: valor }))
    if (Object.keys(this.erros()).length > 0) this.erros.set({})
    this.erroGeral.set(null)
  }

  async salvar(ev: Event): Promise<void> {
    ev.preventDefault()
    if (this.salvando() || this.leitura()) return
    const corpo = corpoDaEmpresa(this.form())
    const locais = errosDoCorpo(corpo)
    this.erroGeral.set(null)
    if (Object.keys(locais).length > 0) { this.erros.set(locais); this.erroGeral.set(resumoDosErros(locais)); focarPrimeiroInvalido(); return }
    this.salvando.set(true)
    try {
      await firstValueFrom(this.http.patch('/v1/config/empresa', corpo))
      this.erros.set({})
      this.toast.sucesso('Dados da empresa salvos.')
      this.salvou.emit({ ...this.empresa(), ...this.valoresSalvos() })
    } catch (e) {
      const doServidor = errosDoServidor(e)
      if (doServidor) { this.erros.set(doServidor); this.erroGeral.set(resumoDosErros(doServidor)); focarPrimeiroInvalido() }
      else this.erroGeral.set(mensagemFalhaAoSalvar(e))
    } finally { this.salvando.set(false) }
  }

  /** O espelho local depois do PATCH: o mesmo que o formulário mostra, já normalizado. */
  private valoresSalvos(): Partial<EmpresaLida> {
    const f = this.form()
    const dig = (t: string) => t.replace(/\D/g, '')
    const vazio = (t: string) => (t.trim() === '' ? null : t.trim())
    const e = { cep: dig(f.cep), logradouro: f.logradouro.trim(), numero: f.numero.trim(), complemento: f.complemento.trim(), bairro: f.bairro.trim(), cidade: f.cidade.trim(), uf: f.uf }
    return {
      nome: f.nome.trim(), fuso: f.fuso, cnpj: vazio(dig(f.cnpj)), telefone: vazio(dig(f.telefone)), whatsapp: vazio(dig(f.whatsapp)),
      email: vazio(f.email.toLowerCase()), site: vazio(f.site),
      endereco: Object.values(e).every((v) => v === '') ? null : e,
    }
  }
}
