/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ISCMResourceGroup, ISCMResource } from 'vs/workbench/contrib/scm/common/scm';

export function isSCMResource(element: ISCMResourceGroup | ISCMResource): element is ISCMResource {
	return !!(element as ISCMResource).sourceUri;
}