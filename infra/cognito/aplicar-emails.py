#!/usr/bin/env python3
"""
Apply the branded e-mail templates (invite + password-reset code) to the Cognito user pool.

    python3 infra/cognito/aplicar-emails.py            # dry run: validates and shows what changes
    python3 infra/cognito/aplicar-emails.py --aplicar  # calls UpdateUserPool
    ... --fechar-cadastro                              # also turns self sign-up off (AllowAdminCreateUserOnly)

WARNING: UpdateUserPool RESETS every setting that is left out of the call to its default
(password policy, MFA, recovery, e-mail sender...). So the script reads the current pool,
copies every updatable setting and only swaps the templates. Never call update-user-pool
by hand with just the template fields.

Cognito rules checked here, before any network call:
  - invite must contain {username} and {####}; reset code must contain {####};
  - EmailMessage up to 20,000 characters; EmailSubject up to 140.
"""
import json
import subprocess
import sys
from pathlib import Path

POOL = 'us-east-1_QOhAjgnxj'
REGIAO = 'us-east-1'
AQUI = Path(__file__).resolve().parent

ASSUNTO_CONVITE = 'Seu acesso ao Drezz Hub'
ASSUNTO_CODIGO = 'Seu código para criar uma nova senha no Drezz Hub'

# Settings UpdateUserPool accepts (anything read-only in describe-user-pool stays out).
ATUALIZAVEIS = [
    'Policies', 'DeletionProtection', 'LambdaConfig', 'AutoVerifiedAttributes', 'SmsVerificationMessage',
    'SmsAuthenticationMessage', 'UserAttributeUpdateSettings', 'MfaConfiguration', 'DeviceConfiguration',
    'EmailConfiguration', 'SmsConfiguration', 'UserPoolTags', 'AdminCreateUserConfig', 'UserPoolAddOns',
    'AccountRecoverySetting', 'PoolName', 'UserPoolTier',
]


def ler(nome: str, exigidos: list[str]) -> str:
    html = (AQUI / nome).read_text(encoding='utf-8').strip()
    faltam = [p for p in exigidos if p not in html]
    if faltam:
        sys.exit(f'{nome}: faltam os marcadores {faltam} (o Cognito recusa o modelo sem eles).')
    if len(html) > 20_000:
        sys.exit(f'{nome}: {len(html)} caracteres; o Cognito aceita até 20.000.')
    return html


def aws(*args: str) -> dict:
    r = subprocess.run(['aws', 'cognito-idp', *args, '--region', REGIAO, '--output', 'json'],
                       capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(r.stderr.strip())
    return json.loads(r.stdout) if r.stdout.strip() else {}


def main() -> None:
    aplicar = '--aplicar' in sys.argv
    convite = ler('email-convite.html', ['{username}', '{####}'])
    codigo = ler('email-codigo.html', ['{####}'])
    for assunto in (ASSUNTO_CONVITE, ASSUNTO_CODIGO):
        if len(assunto) > 140:
            sys.exit(f'Assunto com mais de 140 caracteres: {assunto}')

    pool = aws('describe-user-pool', '--user-pool-id', POOL)['UserPool']
    entrada = {'UserPoolId': POOL, **{k: pool[k] for k in ATUALIZAVEIS if k in pool}}

    criar = dict(entrada.get('AdminCreateUserConfig', {}))
    # Read-only in describe for some pools; UpdateUserPool rejects it inside AdminCreateUserConfig.
    criar.pop('UnusedAccountValidityDays', None)
    modelo = dict(criar.get('InviteMessageTemplate', {}))
    modelo.update({'EmailSubject': ASSUNTO_CONVITE, 'EmailMessage': convite})
    criar['InviteMessageTemplate'] = modelo
    # --fechar-cadastro: only the API (AdminCreateUser) creates logins. With self sign-up open,
    # anyone holding the public client id can call SignUp and set the immutable custom:tenant_id
    # (it is writable at creation) — and the API creates the `usuario` row on the first request.
    if '--fechar-cadastro' in sys.argv:
        criar['AllowAdminCreateUserOnly'] = True
    entrada['AdminCreateUserConfig'] = criar

    verif = dict(pool.get('VerificationMessageTemplate', {}))
    verif.update({'DefaultEmailOption': verif.get('DefaultEmailOption', 'CONFIRM_WITH_CODE'),
                  'EmailSubject': ASSUNTO_CODIGO, 'EmailMessage': codigo})
    entrada['VerificationMessageTemplate'] = verif

    print(f'Pool {POOL} ({pool.get("Name")}) — configurações copiadas: {sorted(k for k in entrada if k != "UserPoolId")}')
    print(f'Convite: "{ASSUNTO_CONVITE}" ({len(convite)} caracteres)')
    print(f'Código:  "{ASSUNTO_CODIGO}" ({len(codigo)} caracteres)')
    print(f'Remetente: {pool.get("EmailConfiguration", {}).get("EmailSendingAccount", "COGNITO_DEFAULT")}')
    print(f'Autocadastro (SignUp): {"fechado" if criar.get("AllowAdminCreateUserOnly") else "ABERTO"}')
    if not aplicar:
        print('\nSimulação: nada foi alterado. Rode com --aplicar para gravar.')
        return

    arquivo = AQUI / '.entrada-update-user-pool.json'
    arquivo.write_text(json.dumps(entrada, ensure_ascii=False), encoding='utf-8')
    try:
        aws('update-user-pool', '--cli-input-json', f'file://{arquivo}')
    finally:
        arquivo.unlink(missing_ok=True)

    depois = aws('describe-user-pool', '--user-pool-id', POOL)['UserPool']
    ok = (depois['AdminCreateUserConfig'].get('InviteMessageTemplate', {}).get('EmailSubject') == ASSUNTO_CONVITE
          and depois.get('VerificationMessageTemplate', {}).get('EmailSubject') == ASSUNTO_CODIGO)
    for k in ('Policies', 'MfaConfiguration', 'AccountRecoverySetting', 'AutoVerifiedAttributes'):
        if pool.get(k) != depois.get(k):
            print(f'⚠️  {k} mudou depois do update — confira no console da AWS.')
    print('Modelos aplicados.' if ok else 'O update rodou, mas os assuntos não conferem — confira no console da AWS.')


if __name__ == '__main__':
    main()
