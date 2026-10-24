package agentos

import rego.v1

tools_for(tools, "manage", "readOnly") := array.concat(object.get(tools, "readOnly", []), object.get(tools, "managementReadOnly", []))
tools_for(tools, access, "readOnly") := object.get(tools, "readOnly", []) if access != "manage"
tools_for(tools, "manage", "write") := object.get(tools, "management", [])
tools_for(tools, "operate", "write") := object.get(tools, "write", [])
tools_for(_, "read", "write") := []
