/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ResolvedAuthority, IRemoteAuthorityResolverService } from 'vs/platform/remote/common/remoteAuthorityResolver';
import { ipcRenderer as ipc } from 'electron';
import * as errors from 'vs/base/common/errors';

class PendingResolveAuthorityRequest {
	constructor(
		public readonly resolve: (value: ResolvedAuthority) => void,
		public readonly reject: (err: any) => void,
		public readonly promise: Promise<ResolvedAuthority>,
	) {
	}
}

export class RemoteAuthorityResolverService implements IRemoteAuthorityResolverService {

	_serviceBrand: any;

	private _resolveAuthorityRequests: { [authority: string]: PendingResolveAuthorityRequest; };

	constructor() {
		this._resolveAuthorityRequests = Object.create(null);
	}

	resolveAuthority(authority: string): Promise<ResolvedAuthority> {
		if (!this._resolveAuthorityRequests[authority]) {
			let resolve: (value: ResolvedAuthority) => void;
			let reject: (err: any) => void;
			let promise = new Promise<ResolvedAuthority>((_resolve, _reject) => {
				resolve = _resolve;
				reject = _reject;
			});
			this._resolveAuthorityRequests[authority] = new PendingResolveAuthorityRequest(resolve!, reject!, promise);
		}
		return this._resolveAuthorityRequests[authority].promise;
	}

	clearResolvedAuthority(authority: string): void {
		if (this._resolveAuthorityRequests[authority]) {
			this._resolveAuthorityRequests[authority].reject(errors.canceled());
			delete this._resolveAuthorityRequests[authority];
		}
	}

	setResolvedAuthority(resolvedAuthority: ResolvedAuthority) {
		if (this._resolveAuthorityRequests[resolvedAuthority.authority]) {
			let request = this._resolveAuthorityRequests[resolvedAuthority.authority];
			ipc.send('vscode:remoteAuthorityResolved', resolvedAuthority);
			request.resolve(resolvedAuthority);
		}
	}

	setResolvedAuthorityError(authority: string, err: any): void {
		if (this._resolveAuthorityRequests[authority]) {
			let request = this._resolveAuthorityRequests[authority];
			request.reject(err);
		}
	}
}
