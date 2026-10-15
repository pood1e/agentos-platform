require 'json'

# Native Zammad objects for the AgentOS reference approval provider. Prints the approver role and the change
# coordinator's API token; neither is passed into the container.
UserInfo.current_user_id = 1
changed = false
update = lambda do |record, attributes|
  attributes.each { |name, value| record[name] = value if record[name] != value }
  if record.new_record? || record.changed?
    record.save!
    changed = true
  end
  record
end

group = update.call(Group.find_or_initialize_by(name: 'AgentOS Changes'), {active: true})
permission = Permission.find_by!(name: 'ticket.agent')
approver = update.call(Role.find_or_initialize_by(name: 'Human Change Approver'), {active: true})
if approver.permissions.ids.sort != [permission.id]
  approver.permissions = [permission]
  changed = true
end

agent = Role.find_by!(name: 'Agent')
coordinator = update.call(User.find_or_initialize_by(login: 'agentos-coordinator'),
  {email: 'agentos-coordinator@local.domain', firstname: 'AgentOS', lastname: 'Coordinator', active: true})
if coordinator.roles.ids.sort != [agent.id]
  coordinator.roles = [agent]
  changed = true
end
if coordinator.group_ids_access_map != {group.id => ['full']}
  coordinator.group_ids_access_map = {group.id => ['full']}
  coordinator.save!
  changed = true
end
token = Token.find_by(action: 'api', user_id: coordinator.id, persistent: true)
unless token
  token = Token.create!(action: 'api', user_id: coordinator.id, persistent: true,
    preferences: {'permission' => {'ticket.agent' => true}, 'name' => 'AgentOS change control'})
  changed = true
end

attributes = {
  'agentos_change_key' => ['变更标识', 'input', {type: 'text', maxlength: 64}],
  'agentos_plan_hash' => ['方案摘要', 'input', {type: 'text', maxlength: 64}],
  'agentos_proposal' => ['原始方案', 'textarea', {maxlength: 131072}],
  'agentos_change_type' => ['变更类型', 'select', {default: 'normal', options: {'normal' => '正常变更', 'standard' => '标准变更', 'emergency' => '紧急变更'}}],
  'agentos_impact' => ['影响分析', 'textarea', {maxlength: 8000}],
  'agentos_validation' => ['验证计划', 'textarea', {maxlength: 8000}],
  'agentos_rollback' => ['回退计划', 'textarea', {maxlength: 8000}],
  'agentos_decision' => ['审批决定', 'select', {default: 'pending', options: {'pending' => '待审核', 'approved' => '批准', 'rejected' => '拒绝'}}],
  'agentos_reason' => ['审批意见', 'textarea', {maxlength: 8000}],
}
ticket = ObjectLookup.find_by!(name: 'Ticket')
attributes.each do |name, (label, type, options)|
  next if ObjectManager::Attribute.find_by(object_lookup_id: ticket.id, name: name)
  shown = name != 'agentos_proposal'
  ObjectManager::Attribute.add(object: 'Ticket', name: name, display: label, data_type: type,
    data_option: options.merge(null: true), active: true, editable: true,
    screens: {create_middle: {'ticket.agent' => {shown: shown, required: false}}, edit: {'ticket.agent' => {shown: shown, required: false}}},
    position: 2000 + attributes.keys.index(name), created_by_id: 1, updated_by_id: 1)
  changed = true
end
ObjectManager::Attribute.migration_execute

unless Setting.get('api_token_access')
  Setting.set('api_token_access', true)
  changed = true
end
puts JSON.generate(changed: changed, approver_role_id: approver.id, coordinator_token: token.token)
