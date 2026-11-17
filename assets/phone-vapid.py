"""Exact local-only Kokuban credential, JSON pipes only; never enumerates other secrets."""
import json
import os
import sys

sys.path.insert(0, os.getcwd())  # The existing computeruse repository/venv owns this credential bridge.
import win32cred
import pywintypes
from harness.passwords import write_credential

target = 'kokuban/phone-vapid'
try:
    request = json.load(sys.stdin)
    if request.get('op') == 'get':
        try:
            value = win32cred.CredRead(target, win32cred.CRED_TYPE_GENERIC, 0)['CredentialBlob']
            if isinstance(value, bytes):
                value = value.decode('utf-8')
            result = json.loads(value)
        except pywintypes.error as error:
            if error.winerror != 1168:
                raise
            result = None
    elif request.get('op') == 'set':
        value = request['value']
        if set(value) != {'publicKey', 'privateKey'} or not all(isinstance(x, str) and 30 < len(x) < 200 for x in value.values()):
            raise ValueError('invalid key pair')
        write_credential(target, 'Kokuban phone Web Push', json.dumps(value).encode('utf-8'), 'Local-only VAPID signing key; excluded from computeruse vault sync')
        result = {'ok': True}
    else:
        raise ValueError('unsupported operation')
    print(json.dumps(result))
except Exception:
    sys.stderr.write('Kokuban local credential operation failed\n')
    sys.exit(1)
