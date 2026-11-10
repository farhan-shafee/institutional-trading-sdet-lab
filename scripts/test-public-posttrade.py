"""Own one disposable public-profile image/database; never target a hosted service."""
from pathlib import Path
import hashlib
import json
import os
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
from owned_loopback_port import owned_loopback_port

if sys.argv[1:] == ['--help']:
    print('Use --verify for full image/browser qualification or --verify-db / --verify-ui for targeted qualification. No external target is accepted.')
    raise SystemExit(0)
if sys.argv[1:] not in (['--verify'], ['--verify-db'], ['--verify-ui']) or os.name != 'posix':
    print('Public image verification requires POSIX/WSL and --verify; no external target is accepted.', file=sys.stderr)
    raise SystemExit(2)
root = Path(__file__).resolve().parent.parent
nonce = secrets.token_hex(16)
label = 'tradeflow.public-owner'
name = 'tradeflow-public-test-' + nonce
volume = name + '-data'
image = 'tradeflow-public-test:' + nonce
application_image = 'tradeflow-public-application-test:' + nonce
network = name + '-network'
evidence = root / '.local' / ('public-posttrade-image-evidence-' + nonce)
if (root / '.local').is_symlink():
    raise SystemExit('Refusing symlinked private evidence directory.')
(root / '.local').mkdir(exist_ok=True,mode=0o700)
local_info=(root / '.local').stat()
if local_info.st_uid!=os.getuid() or local_info.st_mode & 0o022:
    raise SystemExit('Private evidence requires an owned directory without foreign write access.')
evidence.mkdir(parents=True, mode=0o700)
state = Path(tempfile.mkdtemp(prefix='tradeflow-public-private-'))
state.chmod(0o700)
active = None
cancelled = 0
results = {}
passwords = {}
containers=[name]


def private(path, content):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def invoke(arguments, log=None, check=True, env=None):
    global active
    with (log.open('x') if log else open(os.devnull, 'w')) as output:
        active = subprocess.Popen(arguments, cwd=root, env=env, start_new_session=True,
                                  stdout=output, stderr=subprocess.STDOUT)
        try:
            code = active.wait(timeout=300)
        finally:
            if active.poll() is None:
                os.killpg(active.pid, signal.SIGTERM)
                try:
                    active.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(active.pid, signal.SIGKILL)
                    active.wait()
            active = None
    if log:
        results[log.stem+'_exit']=code
    if check and code != 0:
        raise RuntimeError('Owned public verification command failed; inspect the private log.')
    return code


def docker(*arguments):
    try:
        return subprocess.check_output(['docker', *arguments], cwd=root, text=True,
                                       stderr=subprocess.PIPE,timeout=15).strip()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        detail = error.stderr or ''
        if isinstance(detail, bytes):
            detail = detail.decode('utf8', errors='replace')
        for password in passwords.values():
            detail = detail.replace(password, '[REDACTED]')
        results['docker_failure'] = {'operation': list(arguments[:2]), 'type': type(error).__name__}
        private(evidence / ('docker-failure-' + secrets.token_hex(4) + '.json'),
                json.dumps({**results['docker_failure'], 'stderr': detail}))
        raise


def matches(kind, identifier):
    labels = json.loads(docker(kind, 'inspect', identifier, '--format', '{{json .Config.Labels}}'
                              if kind in ('container', 'image') else '{{json .Labels}}'))
    return labels.get(label) == nonce


def stop(signum, _frame):
    global cancelled
    cancelled = 128 + signum
    raise KeyboardInterrupt()


signal.signal(signal.SIGINT, stop)
signal.signal(signal.SIGTERM, stop)
try:
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
    if subprocess.check_output(['git', 'status', '--porcelain'], cwd=root, text=True).strip():
        raise RuntimeError('Native public verification requires a clean published source revision.')
    files = subprocess.check_output(['git', 'ls-files', '--cached', '--modified', '--others', '--exclude-standard'], cwd=root, text=True).splitlines()
    snapshot = {path: hashlib.sha256((root / path).read_bytes()).hexdigest() for path in sorted(set(files))}
    source = hashlib.sha256(json.dumps(snapshot, sort_keys=True).encode()).hexdigest()
    results.update({
        'profile': 'public-posttrade-v1',
        'qualification': 'native-application-and-browsers' if sys.argv[1:] == ['--verify'] else
                         'targeted-http-and-browsers' if sys.argv[1:] == ['--verify-ui'] else 'targeted-database',
        'source_revision': revision,
        'source_tree': subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], cwd=root, text=True).strip(),
        'source_snapshot': source,
        'source_state': 'CLEAN',
        'node_runtime': subprocess.check_output(['node', '--version'], text=True).strip(),
        'expected_schema_revision': 10,
        'public_profile_checksum': hashlib.sha256((root / 'db/public-posttrade/001_profile.sql').read_bytes()).hexdigest(),
    })
    invoke(['node', '--import', 'tsx', 'scripts/check-public-posttrade-profile.ts'],
           evidence / 'source-admission.log')
    passwords = {role: secrets.token_urlsafe(32) for role in ['admin', 'app', 'migrator', 'reconciler', 'maintenance']}
    database = 'tradeflow_public_demo_' + nonce[:16]
    port = owned_loopback_port()
    hostname = 'public-postgres.railway.internal'
    owner = {'version': 1, 'nonce': nonce, 'container': name, 'volume': volume,
             'source_snapshot': source, 'database': database, 'hostname': hostname}
    for role, password in passwords.items():
        owner[role + 'Url'] = f'postgresql://{"postgres" if role == "admin" else "tf_" + role}:{password}@{hostname}:{port}/{database}'
    private(state / 'owner.json', json.dumps(owner))
    private(state / 'database.env', '\n'.join([
        'POSTGRES_USER=postgres', 'POSTGRES_DB=' + database, 'POSTGRES_PASSWORD=' + passwords['admin'],
        'TF_DEMO_OWNER_NONCE=' + nonce, 'TF_DB_DNS=' + hostname,
        *['TF_' + role.upper() + '_PASSWORD=' + passwords[role] for role in ['app', 'migrator', 'reconciler', 'maintenance']],
    ]) + '\n')
    print('Public test recovery descriptor: ' + str(state / 'owner.json'), flush=True)
    invoke(['docker', 'build', '--label', label + '=' + nonce, '-t', image,
            '-f', 'deployment/posttrade-postgres/Dockerfile', '.'], evidence / 'build.log')
    docker('network', 'create', '--label', label + '=' + nonce, network)
    docker('volume', 'create', '--label', label + '=' + nonce, volume)
    invoke(['docker', 'create', '--name', name, '--label', label + '=' + nonce,
            '--env-file', str(state / 'database.env'), '--publish', f'127.0.0.1:{port}:5432',
            '--network', network, '--network-alias', hostname,
            '--mount', f'type=volume,source={volume},target=/var/lib/postgresql/data',
            '--cpus=0.5', '--memory=512m', '--shm-size=64m', '--pids-limit=128', image], evidence / 'create.log')
    docker('container', 'start', name)
    ready = False
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        state_status = docker('container', 'inspect', name, '--format', '{{.State.Status}}')
        if state_status != 'running':
            break
        result = subprocess.run(['docker', 'exec', '--user', 'postgres', name, 'psql', '-U', 'postgres', '-d', database, '-Atqc',
                                 "SELECT profile_name FROM fi_control.public_demo_profile WHERE singleton"],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        tcp=subprocess.run(['docker','exec','--user','postgres',name,'pg_isready','-h','127.0.0.1','-p','5432','-U','postgres','-d',database],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5)
        if result.returncode == 0 and result.stdout.strip() == 'public-posttrade-v1' and tcp.returncode==0:
            ready = True
            break
        time.sleep(0.1)
    if not ready:
        raise RuntimeError('Dedicated PostgreSQL image did not become ready; inspect private logs.')
    ca = docker('exec', name, '/usr/local/bin/tradeflow-postgres', 'export-ca') + '\n'
    if 'BEGIN CERTIFICATE' not in ca or 'PRIVATE KEY' in ca:
        raise RuntimeError('Public CA export was invalid.')
    owner['ca'] = ca
    private(state / 'owner-next.json', json.dumps(owner))
    (state / 'owner-next.json').replace(state / 'owner.json')
    directory_fd=os.open(state,os.O_RDONLY|os.O_DIRECTORY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    env = dict(os.environ)
    env.pop('TF_DB_OWNER_FILE', None)
    env['TF_PUBLIC_IMAGE_OWNER_FILE'] = str(state / 'owner.json')
    results['node'] = invoke(['node', '--import', 'tsx', 'scripts/verify-public-posttrade-image.ts'], evidence / 'node.log', env=env)
    if sys.argv[1:] == ['--verify']:
        invoke(['docker', 'build', '--label', label + '=' + nonce,
                '--build-arg', 'RAILWAY_GIT_COMMIT_SHA=' + revision, '-t', application_image,
                '-f', 'deployment/application/Dockerfile', '.'], evidence / 'native-build.log')
        application_port = owned_loopback_port()
        application = name + '-application'
        containers.append(application)
        private(state / 'application.env', '\n'.join([
            'PORT=3000', 'TRADEFLOW_HOST=0.0.0.0', 'TRADEFLOW_MODE=hosted-demo', 'TRADEFLOW_PUBLIC_DEMO=on', 'TRADEFLOW_PUBLIC_POSTTRADE=on',
            *[setting + '=postgresql://tf_' + role + ':' + passwords[role] + '@' + hostname + ':5432/' + database
              for role, setting in [('app', 'TRADEFLOW_PUBLIC_DEMO_DATABASE_URL'),
                                    ('reconciler', 'TRADEFLOW_PUBLIC_DEMO_RECONCILER_URL'),
                                    ('maintenance', 'TRADEFLOW_PUBLIC_DEMO_MAINTENANCE_URL')]],
        ]) + '\n')
        invoke(['docker', 'create', '--name', application, '--label', label + '=' + nonce,
                '--env-file', str(state / 'application.env'), '--env', 'TRADEFLOW_PUBLIC_DEMO_DATABASE_CA=' + ca,
                '--network', network, '--publish', f'127.0.0.1:{application_port}:3000',
                '--cpus=0.5', '--memory=500000000', '--shm-size=64m', '--pids-limit=128', application_image], evidence / 'native-create.log')
        docker('container', 'start', application)
        owner['nativeOrigin'] = f'http://127.0.0.1:{application_port}'
        deadline = time.monotonic() + 30
        ready = False
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(owner['nativeOrigin'] + '/health', timeout=2) as response:
                    ready = response.status == 200
                if ready:
                    break
            except Exception:
                time.sleep(0.1)
        if not ready:
            raise RuntimeError('Native application image did not become ready.')
        invoke(['docker', 'exec', application, 'node', '--import', 'tsx', '--input-type=module', '-e',
                "import assert from 'node:assert/strict'; import { verificationManifest } from './app/server/reconciliation/manifest.ts'; const metadata=await verificationManifest(); assert.equal(metadata.source_revision,process.env.RAILWAY_GIT_COMMIT_SHA); assert.equal(metadata.source_state,'CLEAN'); console.log('Native public reconciliation has genuine clean Git source provenance.');"], evidence / 'native-provenance.log')
        private(state / 'owner-native.json', json.dumps(owner))
        (state / 'owner-native.json').replace(state / 'owner.json')
        directory_fd=os.open(state,os.O_RDONLY|os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    if sys.argv[1:] in (['--verify'], ['--verify-ui']):
        for title, command in [
            ('browser', ['node', 'node_modules/@playwright/test/cli.js', 'test', '--config=playwright.public-posttrade.config.ts']),
            ('browser-repeat', ['node', 'node_modules/@playwright/test/cli.js', 'test', '--config=playwright.public-posttrade.config.ts', '--repeat-each=2']),
        ]:
            artifacts=root/'test-results'/'public-posttrade-private'
            if title.startswith('browser') and artifacts.exists():
                shutil.copytree(artifacts,evidence/(title+'-previous-artifacts'))
            results[title] = invoke(command, evidence / (title + '.log'), env=env)
    # Exercise refusal against our own volume while the legitimate instance is stopped.
    if not matches('container',name) or not matches('volume',volume):
        raise RuntimeError('Owned image identity changed; preserving resources.')
    invoke(['docker','container','stop','--time=5',name],evidence/'guard-stop.log')
    original_environment=(state/'database.env').read_text()
    for index,contents in enumerate([
        original_environment.replace('TF_DEMO_OWNER_NONCE='+nonce,'TF_DEMO_OWNER_NONCE='+secrets.token_hex(16)),
        original_environment.replace('TF_MAINTENANCE_PASSWORD='+passwords['maintenance'],'TF_MAINTENANCE_PASSWORD='+passwords['app']),
    ]):
        guard=name+'-guard-'+str(index);containers.append(guard)
        private(state/f'guard-{index}.env',contents)
        invoke(['docker','create','--name',guard,'--label',label+'='+nonce,'--env-file',str(state/f'guard-{index}.env'),
                '--mount',f'type=volume,source={volume},target=/var/lib/postgresql/data',
                '--cpus=0.5','--memory=512m','--shm-size=64m','--pids-limit=128',image],evidence/f'guard-{index}-create.log')
        docker('container','start',guard)
        deadline=time.monotonic()+15
        while time.monotonic()<deadline and docker('container','inspect',guard,'--format','{{.State.Status}}')=='running':
            time.sleep(0.1)
        if docker('container','inspect',guard,'--format','{{.State.Status}}')!='exited' or docker('container','inspect',guard,'--format','{{.State.ExitCode}}')!='1':
            raise RuntimeError('Invalid identity/authority was not rejected.')
        invoke(['docker','cp',guard+':/var/lib/postgresql/data/tls/root.pem',str(state/f'guard-{index}-ca.pem')],evidence/f'guard-{index}-copy.log')
        if (state/f'guard-{index}-ca.pem').read_text().strip()!=ca.strip():
            raise RuntimeError('Invalid startup changed the retained CA.')
    results['identity_and_authority_refusal']=True
    if (subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip() != revision or
            subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=all'], cwd=root, text=True).strip()):
        results['source_state'] = 'CHANGED'
        raise RuntimeError('Owned qualification source changed during execution.')
except KeyboardInterrupt:
    results['cancelled'] = cancelled or 130
except Exception as error:
    results['failed'] = True
    detail = str(error)
    for password in passwords.values():
        detail = detail.replace(password, '[REDACTED]')
    private(evidence / 'failure.json', json.dumps({'type': type(error).__name__, 'detail': detail}))
    print('Public image verification failed; private evidence: ' + str(evidence), file=sys.stderr, flush=True)
finally:
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    clean = False
    try:
        for identifier in containers:
            if identifier in docker('container', 'ls', '-a', '--format', '{{.Names}}').splitlines():
                if not matches('container', identifier):
                    raise RuntimeError('Foreign container preserved.')
                with (evidence / ('database.log' if identifier==name else identifier+'.log')).open('x') as log:
                    subprocess.run(['docker', 'logs', identifier], stdout=log, stderr=subprocess.STDOUT, check=False)
                invoke(['docker', 'container', 'stop', '--time=5', identifier], check=False)
                docker('container', 'rm', identifier)
        if volume in docker('volume', 'ls', '--format', '{{.Name}}').splitlines():
            if not matches('volume', volume):
                raise RuntimeError('Foreign volume preserved.')
            docker('volume', 'rm', volume)
        if network in docker('network', 'ls', '--format', '{{.Name}}').splitlines():
            if not matches('network', network):
                raise RuntimeError('Foreign network preserved.')
            docker('network', 'rm', network)
        for candidate_image in [application_image, image]:
            if candidate_image in docker('image', 'ls', '--format', '{{.Repository}}:{{.Tag}}').splitlines():
                if not matches('image', candidate_image):
                    raise RuntimeError('Foreign image preserved.')
                docker('image', 'rm', candidate_image)
        results['secret_material_absent']=all(not any(password.encode() in path.read_bytes() for password in passwords.values()) for path in evidence.rglob('*') if path.is_file())
        if not results['secret_material_absent']:
            results['failed']=True
        shutil.rmtree(state)
        clean = True
    except Exception:
        print('Owned cleanup incomplete; descriptor and evidence preserved. Do not prune shared resources.', file=sys.stderr)
    results['owned_cleanup_complete'] = clean
    private(evidence / 'receipt.json', json.dumps(results, indent=2))
    print(json.dumps({'evidence': str(evidence), **results}), flush=True)
raise SystemExit(cancelled or (1 if results.get('failed') or not clean else 0))
